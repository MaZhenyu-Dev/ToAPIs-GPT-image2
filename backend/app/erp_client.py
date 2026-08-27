"""七彩ERP（erp.funhan.cn）客户端：登录、会话探测、店铺/订单同步、图片上传。

设计要点：
- 所有请求复用同一个 httpx.AsyncClient（自带 cookie jar），cookies 从数据库
  erp_config 表加载 / 回写，会话过期后由调用方提示用户重新登录（不存密码）。
- Yii2 应用：登录需先 GET 登录页拿 CSRF token（meta 标签），POST 时携带；
  所有 POST 请求统一附加 X-CSRF-Token 请求头（与 yii.js 行为一致）。
- 页面解析基于 class 约定（.kv-grid-table / .goods_sn / .order-sn 等），
  用 BeautifulSoup 解析，字段映射见 parse_* 函数。
"""

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Optional

import httpx
from bs4 import BeautifulSoup

from backend.app.config import settings

ERP_BASE_URL = "http://erp.funhan.cn"

# ERP 页面路由（Yii2）
LOGIN_URL = "/index.php?r=site%2Flogin"
STORE_LIST_URL = "/index.php?r=temu%2Fsupplier%2Findex"
IMAGE_MISSING_URL = "/index.php?r=temu%2Fproduce-order-item%2Fimage-missing"
UPLOAD_IMAGE_URL = "/index.php?r=temu%2Fproduce-order-item%2Fajax-upload-image"
SUBMIT_IMAGE_URL = "/index.php?r=temu%2Fproduce-order-item%2Fajax-submit-image"


class ErpSessionError(Exception):
    """ERP 会话无效 / 已过期：调用方应提示用户重新登录。"""


class ErpRequestError(Exception):
    """ERP 请求失败（非会话问题）。"""


@dataclass
class ErpStore:
    id: int
    name: str


@dataclass
class ErpOrderItem:
    order_item_id: int
    goods_sn: str
    size: str
    sku: str
    skcid: str
    skuid: str
    material: str
    input_image_url: str
    order_sn: str
    quantity: int
    # 店铺信息不在订单行内（页面只展示店铺名），由爬取方从供应商映射传入
    supplier_id: int = 0
    store_name: str = ""
    anomalies: str = field(default="")


class ErpClient:
    """七彩ERP HTTP 客户端（单例，进程内共享连接池与 cookie）。"""

    def __init__(self, base_url: str = ERP_BASE_URL):
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            timeout=30,
            follow_redirects=True,
            trust_env=False,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
                )
            },
        )
        self._cookies_loaded = False
        self._csrf_token: Optional[str] = None

    # ---------- cookie 管理 ----------

    def set_cookies(self, cookie_dict: dict[str, str]) -> None:
        """从数据库载入 cookie 字典（登录后/启动时调用）。"""
        self._client.cookies.clear()
        for name, value in cookie_dict.items():
            self._client.cookies.set(name, value, domain=self._host)
        self._cookies_loaded = bool(cookie_dict)

    def get_cookies(self) -> dict[str, str]:
        """导出当前 cookie 字典（供持久化到数据库）。"""
        return {k: v for k, v in self._client.cookies.items()}

    @property
    def _host(self) -> str:
        return self.base_url.split("//")[1].split("/")[0]

    def has_cookies(self) -> bool:
        return self._cookies_loaded

    # ---------- 基础请求 ----------

    async def _request(
        self,
        method: str,
        url_path: str,
        *,
        max_retries: int = 2,
        **kwargs,
    ) -> httpx.Response:
        last_exc: Optional[Exception] = None
        for attempt in range(max_retries + 1):
            try:
                response = await self._client.request(method, url_path, **kwargs)
                return response
            except httpx.RequestError as exc:
                last_exc = exc
                if attempt == max_retries:
                    raise ErpRequestError(f"ERP 请求失败: {exc}") from exc
                await asyncio.sleep(0.5 * (attempt + 1))
        raise ErpRequestError(f"ERP 请求失败: {last_exc}")

    async def _get_page(self, url_path: str) -> str:
        """GET 页面并检查会话是否有效（302 到登录页 = 会话过期）。

        每次 GET 都同步页面里的最新 CSRF token（ERP 会话每次请求轮换，
        缓存的旧 token 会导致后续 POST 被 CSRF 校验拒绝返回 400）。
        """
        response = await self._client.get(self.base_url + url_path)
        if self._is_login_redirect(response, requested=url_path):
            raise ErpSessionError("ERP 登录已过期，请重新登录")
        self._update_csrf(response.text)
        return response.text

    @staticmethod
    def _is_login_redirect(response: httpx.Response, requested: str = "") -> bool:
        """判断请求是否被重定向到了登录页。

        注意：登录页 URL 本身就包含 site%2Flogin，主动请求登录页时
        不能判为会话过期（此时拿到登录页是正常行为）。
        """
        if "site%2Flogin" in requested or "/site/login" in requested:
            return False
        final_url = str(response.url)
        return "site%2Flogin" in final_url or "/site/login" in final_url

    def _update_csrf(self, html: str) -> None:
        """从页面 meta 标签更新 CSRF token（yii.js 行为一致）。"""
        m = re.search(
            r'<meta\s+name="csrf-token"\s+content="([^"]+)"', html
        )
        if m:
            self._csrf_token = m.group(1)

    def _post_headers(self) -> dict[str, str]:
        headers = {"X-Requested-With": "XMLHttpRequest"}
        if self._csrf_token:
            headers["X-CSRF-Token"] = self._csrf_token
        return headers

    # ---------- 登录 ----------

    async def login(self, username: str, password: str) -> bool:
        """用账号密码登录，成功后持久化 cookie（调用方负责存库）。

        登录页为 Yii2 标准表单：动态解析表单字段名（*username* / *password*
        及其它隐藏字段），避免硬编码字段名不匹配的问题。
        """
        # 清掉旧 cookie：保证拿到的是登录页（否则 302 跳首页导致解析失败）
        self._client.cookies.clear()
        self._cookies_loaded = False
        self._csrf_token = None

        # 1) 获取登录页 + CSRF + 表单字段结构
        login_page = await self._get_page(LOGIN_URL)
        if not self._is_login_page(login_page):
            raise ErpRequestError("ERP 登录页结构异常，请检查 ERP 是否可达")
        self._update_csrf(login_page)

        form_fields = self._parse_login_form_fields(login_page)
        username_field = next(
            (f for f in form_fields if "username" in f.lower() or "account" in f.lower()),
            "LoginForm[username]",
        )
        password_field = next(
            (f for f in form_fields if "password" in f.lower()),
            "LoginForm[password]",
        )
        remember_field = next(
            (f for f in form_fields if "remember" in f.lower() or "rememberme" in f.lower()),
            None,
        )

        data: dict[str, str] = {username_field: username, password_field: password}
        if self._csrf_token:
            data["_csrf-backend"] = self._csrf_token
        if remember_field:
            data[remember_field] = "1"

        response = await self._client.post(
            self.base_url + LOGIN_URL,
            data=data,
            headers=self._post_headers(),
        )

        # 登录成功 → 302 到首页；失败 → 重新渲染登录页
        if not self._is_login_page(response.text):
            self._cookies_loaded = True
            # 登录后的页面顺手拿最新 CSRF
            self._update_csrf(response.text)
            return True

        # 尝试解析登录失败原因（Yii2 错误列表 .error-summary）
        soup = BeautifulSoup(response.text, "html.parser")
        error_box = soup.select_one(".error-summary")
        reason = error_box.get_text(" ", strip=True) if error_box else "账号或密码错误"
        raise ErpRequestError(f"ERP 登录失败：{reason}")

    @staticmethod
    def _is_login_page(html: str) -> bool:
        """通过特征片段判断当前页面是否为登录页。"""
        return (
            "password" in html.lower()
            and ("login-box" in html or "login-form" in html.lower())
            and "店铺管理" not in html
        )

    @staticmethod
    def _parse_login_form_fields(html: str) -> list[str]:
        """解析登录表单中所有 input 的 name（含隐藏字段）。"""
        soup = BeautifulSoup(html, "html.parser")
        names: list[str] = []
        for inp in soup.select("form input[name]"):
            name = inp.get("name")
            if name and name not in names:
                names.append(name)
        return names

    # ---------- 会话探测 ----------

    async def check_session(self) -> bool:
        """探测会话是否有效：访问店铺管理页，能正常渲染即有效。"""
        if not self._cookies_loaded:
            return False
        try:
            html = await self._get_page(STORE_LIST_URL)
        except ErpSessionError:
            return False
        except ErpRequestError:
            return False
        return "店铺管理" in html

    # ---------- 店铺列表同步 ----------

    async def get_stores(self) -> list[ErpStore]:
        """同步店铺管理页全部店铺（分页循环直到无数据）。"""
        stores: list[ErpStore] = []
        seen_ids: set[int] = set()
        page = 1
        while True:
            url = f"{STORE_LIST_URL}&page={page}"
            html = await self._get_page(url)
            parsed = self._parse_stores(html)
            if not parsed:
                break
            for store in parsed:
                if store.id not in seen_ids:
                    seen_ids.add(store.id)
                    stores.append(store)
            if len(parsed) < 20:
                break
            page += 1
        return stores

    @staticmethod
    def _parse_stores(html: str) -> list[ErpStore]:
        """解析店铺管理表格。

        列结构（kv-grid-table）：checkbox | ID | 负责人 | 店铺ID | 店铺名称 | ...
        店铺名称单元格内有 "设置别名" 按钮（button 文本含店铺名）。
        """
        soup = BeautifulSoup(html, "html.parser")
        table = soup.select_one(".kv-grid-table")
        if not table:
            return []
        stores: list[ErpStore] = []
        for row in table.select("tbody tr"):
            tds = row.select("td")
            if len(tds) < 5:
                continue
            # 第一列是 checkbox；第二列 ID；第三列负责人；第四列 TEMU 店铺ID；第五列店铺名称
            id_text = tds[1].get_text(" ", strip=True)
            name_cell = tds[4]
            name_btn = name_cell.select_one("button")
            name = (
                (name_btn.get_text(strip=True) if name_btn else "")
                or name_cell.get_text(" ", strip=True)
            ).split("设置别名")[0].strip()
            try:
                store_id = int(id_text)
            except ValueError:
                continue
            if not name:
                continue
            stores.append(ErpStore(id=store_id, name=name))
        return stores

    # ---------- 图片缺失订单同步 ----------

    async def sync_image_missing_orders(
        self, supplier_ids: list[int], store_names: dict[int, str] | None = None
    ) -> list[ErpOrderItem]:
        """同步图片缺失订单（按店铺 ID 过滤，自动翻页）。

        ``store_names``: supplier_id → 店铺名称 映射（店铺列表同步结果），
        用于把店铺名填充到订单条目（页面订单行内不直接给出店铺 ID）。
        """
        store_names = store_names or {}
        orders: list[ErpOrderItem] = []
        seen_ids: set[int] = set()
        page = 1
        while True:
            filters = "&".join(
                [
                    IMAGE_MISSING_URL,
                    *[
                        f"ProduceOrderItemSearch%5Binclude_supplier_id%5D%5B%5D={sid}"
                        for sid in supplier_ids
                    ],
                    f"page={page}",
                ]
            )
            html = await self._get_page(filters)
            parsed = self._parse_image_missing(html)
            if not parsed:
                break
            for item in parsed:
                if item.order_item_id not in seen_ids:
                    seen_ids.add(item.order_item_id)
                    orders.append(item)
            if len(parsed) < 20:
                break
            page += 1

        # 填充店铺信息（同一请求内所有订单都属于所选店铺之一）
        for item in orders:
            if item.supplier_id == 0 and store_names:
                # 多店铺混爬时无法从行内区分店铺名，这里尽力从行内信息匹配；
                # 若只有一家店铺则直接归属该店
                if len(supplier_ids) == 1:
                    item.supplier_id = supplier_ids[0]
                    item.store_name = store_names.get(supplier_ids[0], "")
        return orders

    @staticmethod
    def _parse_image_missing(html: str) -> list[ErpOrderItem]:
        """解析图片缺失订单表格。

        行内 class 约定（与 ERP 前端 JS / 实际页面结构一致）：
        - tr data-key / 行 checkbox .kv-row-checkbox value = produce_order_item_id
        - .goods_sn          = 内部货号
        - .thumb_url img     = 图片列（AI 输入图）
        - .order-sn          = 备货单号
        - .size              = 尺寸（带 data-width/data-height）
        - div[title="供应商"] = 店铺名称
        - .product-sku       = SKU 货号；同行内 SKCID/SKUID/材质 分行 div
        """
        soup = BeautifulSoup(html, "html.parser")
        table = soup.select_one(".kv-grid-table")
        if not table:
            return []
        items: list[ErpOrderItem] = []
        for row in table.select("tbody tr"):
            checkbox = row.select_one(".kv-row-checkbox")
            order_item_id = checkbox.get("value") if checkbox else None
            if not order_item_id:
                order_item_id = row.get("data-key")  # 兜底：tr data-key
            if not order_item_id:
                continue
            try:
                order_item_id_int = int(order_item_id)
            except ValueError:
                continue

            goods_sn_el = row.select_one(".goods_sn")
            goods_sn = goods_sn_el.get_text(strip=True) if goods_sn_el else ""
            if not goods_sn:
                continue

            thumb_el = row.select_one(".thumb_url")
            input_image_url = ""
            if thumb_el:
                img = thumb_el.select_one("img")
                if img:
                    # data-src 优先（懒加载图），fallback src
                    input_image_url = img.get("data-src") or img.get("src") or ""
                if not input_image_url:
                    link = thumb_el.select_one("a[href]")
                    if link:
                        input_image_url = link.get("href", "") or ""

            order_sn_el = row.select_one(".order-sn")
            order_sn = order_sn_el.get_text(strip=True) if order_sn_el else ""

            store_el = row.select_one('div[title="供应商"]')
            store_name = store_el.get_text(strip=True) if store_el else ""

            size_el = row.select_one(".size")
            size_text = ""
            if size_el:
                # 优先 data-width/data-height（真实数值，避免 "5O*55cm" 这类显示错误）
                width = size_el.get("data-width")
                height = size_el.get("data-height")
                if width and height:
                    size_text = f"{width}x{height}"
                else:
                    size_text = size_el.get_text(strip=True)

            qty_el = row.select_one(".quantity")
            try:
                quantity = int(qty_el.get_text(strip=True)) if qty_el else 1
            except ValueError:
                quantity = 1

            sku = ""
            skcid = ""
            skuid = ""
            material = ""
            sku_el = row.select_one(".product-sku")
            if sku_el:
                sku = sku_el.get_text(strip=True)
            # SKCID / SKUID / 材质：从 SKU 货号单元格的文本行中提取
            sku_cell = sku_el.parent.parent if sku_el and sku_el.parent else None
            if sku_cell is not None:
                for line in sku_cell.get_text("\n", strip=True).splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    if line.startswith("SKCID"):
                        skcid = line.replace("SKCID", "").strip()
                    elif line.startswith("SKUID"):
                        skuid = line.replace("SKUID", "").strip()
                    elif line.startswith("SKU "):
                        continue  # 英寸换算行（如 "SKU 31.5*157.48in/80*400cm"）
                    elif line.startswith("锁边"):
                        continue  # 锁边设置行（如 "锁边未设置"）
                    elif line != sku and not material:
                        material = line

            items.append(
                ErpOrderItem(
                    order_item_id=order_item_id_int,
                    goods_sn=goods_sn,
                    size=size_text,
                    sku=sku,
                    skcid=skcid,
                    skuid=skuid,
                    material=material,
                    input_image_url=input_image_url,
                    order_sn=order_sn,
                    quantity=quantity,
                    store_name=store_name,
                )
            )
        return items

    # ---------- 图片上传 ----------

    async def upload_order_image(
        self, order_item_id: int, goods_sn: str, image_bytes: bytes
    ) -> dict:
        """把一张图片上传到指定订单条目（两步：上传文件 → 提交）。

        返回 ERP 提交接口的完整 JSON（status=success 时 data.thumb/data.image
        为新图地址）。任何一步失败都会抛 ErpRequestError。

        上传前先 GET 一次页面刷新 CSRF token：ERP 的会话 cookie 每次请求
        都会轮换，直接用缓存的旧 token 会被 CSRF 校验拒绝（400 无法验证）。
        """
        # 第一步：刷新 CSRF token（顺带校验会话有效性）
        await self._get_page(IMAGE_MISSING_URL)

        # 第二步：上传图片文件（fileinput 的 ajax-upload-image）
        try:
            upload_resp = await self._client.post(
                self.base_url + UPLOAD_IMAGE_URL,
                files={
                    "image_file": (
                        "product.png",
                        image_bytes,
                        "image/png",
                    )
                },
                data={
                    "name": "image_file",
                    "category": "tm_search",
                    "produce_order_item_id": str(order_item_id),
                    "goods_sn": goods_sn,
                },
                headers=self._post_headers(),
            )
        except httpx.RequestError as exc:
            raise ErpRequestError(f"ERP 图片上传失败: {exc}") from exc
        if self._is_login_redirect(upload_resp):
            raise ErpSessionError("ERP 登录已过期，请重新登录")
        try:
            upload_data = upload_resp.json()
        except Exception as exc:
            raise ErpRequestError(
                f"ERP 上传接口返回异常: {upload_resp.text[:200]}"
            ) from exc

        initial_image = upload_data.get("initialOriginImage") or upload_data.get("url")
        if not initial_image:
            raise ErpRequestError(
                f"ERP 上传接口未返回图片地址: {str(upload_data)[:300]}"
            )

        # 第二步：提交图片到订单
        try:
            submit_resp = await self._client.post(
                self.base_url + SUBMIT_IMAGE_URL,
                data={
                    "produce_order_item_id": str(order_item_id),
                    "image": initial_image,
                },
                headers=self._post_headers(),
            )
        except httpx.RequestError as exc:
            raise ErpRequestError(f"ERP 图片提交失败: {exc}") from exc
        if self._is_login_redirect(submit_resp):
            raise ErpSessionError("ERP 登录已过期，请重新登录")
        try:
            result = submit_resp.json()
        except Exception as exc:
            raise ErpRequestError(
                f"ERP 提交接口返回异常: {submit_resp.text[:200]}"
            ) from exc
        if result.get("status") != "success":
            raise ErpRequestError(
                f"ERP 图片提交失败: {result.get('message') or str(result)[:200]}"
            )
        return result

    # ---------- 图片下载（防盗链处理） ----------

    async def get_image_bytes(self, url: str, timeout: int = 60) -> bytes:
        """下载图片字节流（带浏览器 UA + ERP Referer，绕开 CDN 防盗链）。

        img.cdnfe.com 等图床校验 Referer 与 UA：裸请求返回 403。
        """
        headers = {
            "User-Agent": self._client.headers["User-Agent"],
            "Referer": self.base_url + "/",
        }
        last_exc: Optional[Exception] = None
        for attempt in range(3):
            try:
                response = await self._client.get(url, headers=headers, timeout=timeout)
                response.raise_for_status()
                return response.content
            except httpx.RequestError as exc:
                last_exc = exc
                await asyncio.sleep(0.5 * (attempt + 1))
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                if status in (429, 500, 502, 503, 504) and attempt < 2:
                    last_exc = exc
                    await asyncio.sleep(0.5 * (attempt + 1))
                    continue
                raise ErpRequestError(
                    f"图片下载失败（HTTP {status}，可能被 CDN 防盗链拦截）: {url}"
                ) from exc
        raise ErpRequestError(f"图片下载失败: {last_exc}")

    async def close(self) -> None:
        await self._client.aclose()


erp_client = ErpClient()
