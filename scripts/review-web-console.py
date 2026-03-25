from __future__ import annotations

import json
import re
import sqlite3
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, TimeoutError, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "prisma" / "dev.db"
BASE_URL = "http://127.0.0.1:3000"
API_BASE_URL = "http://127.0.0.1:3001/api"
SCREENSHOT_DIR = Path(tempfile.gettempdir()) / "gfa-web-review"


def log(step: str) -> None:
    print(f"[review] {step}", flush=True)


def api_json(method: str, path: str, body: dict | None = None, token: str | None = None):
    payload = None
    headers = {"Accept": "application/json"}

    if body is not None:
      payload = json.dumps(body).encode("utf-8")
      headers["Content-Type"] = "application/json"

    if token:
      headers["Authorization"] = f"Bearer {token}"

    request = urllib.request.Request(
        f"{API_BASE_URL}/{path}",
        data=payload,
        headers=headers,
        method=method,
    )

    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode("utf-8")) from error


def db_execute(sql: str, params: tuple = ()) -> None:
    with sqlite3.connect(DB_PATH) as connection:
        connection.execute(sql, params)
        connection.commit()


def latest_task_for_order(order_no: str) -> tuple[str, str]:
    with sqlite3.connect(DB_PATH) as connection:
        row = connection.execute(
            """
            SELECT Task.id, "Order".id
            FROM Task
            JOIN "Order" ON "Order".id = Task.orderId
            WHERE "Order".orderNo = ?
            ORDER BY Task.createdAt DESC
            LIMIT 1
            """,
            (order_no,),
        ).fetchone()

    if not row:
        raise AssertionError(f"Task not found for order {order_no}")

    return row[0], row[1]


def expect_text(locator, expected: str, timeout: int = 10000) -> None:
    locator.wait_for(timeout=timeout)
    deadline = time.time() + timeout / 1000

    while time.time() < deadline:
        content = locator.inner_text().strip()
        if expected in content:
            return
        time.sleep(0.2)

    raise AssertionError(f"Expected '{expected}' in '{locator.inner_text().strip()}'")


def attach_debug_listeners(page: Page, console_errors: list[str], page_errors: list[str]) -> None:
    def handle_console(message) -> None:
        if message.type != "error":
            return

        text = message.text
        expected_http_error = (
            text.startswith("Failed to load resource:")
            and any(status in text for status in ("400", "401", "404"))
        )

        if expected_http_error:
            return

        console_errors.append(f"{message.type}: {text}")

    page.on(
        "console",
        handle_console,
    )
    page.on("pageerror", lambda error: page_errors.append(str(error)))


def row_for_text(page: Page, section_id: str, text: str):
    return page.locator(f"#{section_id} tbody tr").filter(has_text=text).first


def wait_for_value(loader, description: str, timeout: int = 10000, interval: float = 0.25):
    deadline = time.time() + timeout / 1000

    while time.time() < deadline:
        value = loader()
        if value:
            return value
        time.sleep(interval)

    raise AssertionError(f"Timed out waiting for {description}")


def open_console_section(page: Page, label: str) -> None:
    page.get_by_role("button", name=label).click()
    page.wait_for_load_state("networkidle")


def open_panel_tab(page: Page, label: str) -> None:
    page.get_by_role("button", name=label).click()


def main() -> int:
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    console_errors: list[str] = []
    page_errors: list[str] = []
    suffix = str(int(time.time()))

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1200})
        attach_debug_listeners(page, console_errors, page_errors)
        admin_token: str | None = None

        try:
            log("public home page")
            page.goto(BASE_URL, wait_until="networkidle")
            expect_text(page.locator("body"), "GOOGLE ONE")
            expect_text(page.locator("body"), "提交邀请")

            log("console requires login")
            page.goto(f"{BASE_URL}/console", wait_until="networkidle")
            expect_text(page.locator("body"), "登录运营账号")

            log("invalid order lookup")
            page.goto(f"{BASE_URL}/status/BAD-ORDER-1", wait_until="networkidle")
            expect_text(page.locator("body"), "Order not found")

            log("invalid redeem code")
            page.goto(f"{BASE_URL}/redeem", wait_until="networkidle")
            page.locator("#redeem-code").fill(" invalid-code ")
            page.locator("#user-email").fill("  someone@example.com")
            page.get_by_role("button", name="提交并开始处理").click()
            expect_text(page.locator("body"), "Invalid or already used redeem code")

            log("invalid operator login")
            page.goto(f"{BASE_URL}/console/login", wait_until="networkidle")
            page.locator("#login-email").fill("admin@gfa.local")
            page.locator("#login-password").fill("wrong-password")
            page.get_by_role("button", name="进入控制台").click()
            expect_text(page.locator("body"), "Invalid credentials")

            log("valid admin login")
            page.locator("#login-email").fill("ADMIN@GFA.LOCAL ")
            page.locator("#login-password").fill("admin123")
            page.get_by_role("button", name="进入控制台").click()
            page.wait_for_url("**/console")
            page.wait_for_load_state("networkidle")
            expect_text(page.locator("body"), "OPERATIONS CONSOLE")
            expect_text(page.locator("body"), "总览")
            admin_token = api_json(
                "POST",
                "auth/login",
                {"email": "admin@gfa.local", "password": "admin123"},
            )["accessToken"]

            log("create account")
            open_console_section(page, "母号池")
            open_panel_tab(page, "新增母号")
            account_name = f"Admin Test Account {suffix}"
            account_email = f"admin-test-{suffix}@example.com"
            profile_id = f"profile-{suffix}"
            page.locator("#account-name").fill(account_name)
            page.locator("#account-email").fill(account_email)
            page.locator("#adspower-profile").fill(profile_id)
            page.locator("#account-notes").fill("review flow account")
            page.locator("form").get_by_role("button", name="新增母号").click()
            expect_text(row_for_text(page, "accounts", account_name), account_email)

            log("create family group")
            open_console_section(page, "家庭组")
            open_panel_tab(page, "新增家庭组")
            group_name = f"Family Slot Pool {suffix}"
            page.locator("#group-account").select_option(label=account_name)
            page.locator("#group-name").fill(group_name)
            page.locator("#group-max").fill("6")
            page.locator("form").get_by_role("button", name="新增家庭组").click()
            expect_text(row_for_text(page, "groups", group_name), "6 slots left")

            log("batch create symbol-free codes")
            open_console_section(page, "卡密")
            open_panel_tab(page, "批量生成")
            if not admin_token:
                raise AssertionError("Missing admin token for code lookup")
            product_without_expiry = f"GOOGLE_ONE_BATCH_{suffix}"
            page.locator("#code-count").fill("2")
            page.locator("#code-product").fill(product_without_expiry)
            page.locator("form").get_by_role("button", name="批量生成卡密").click()
            blank_codes = wait_for_value(
                lambda: (
                    matches
                    if len(
                        matches := [
                            item
                            for item in api_json("GET", "redeem-codes", token=admin_token)
                            if item["product"] == product_without_expiry
                            and item["status"] == "UNUSED"
                        ]
                    )
                    >= 2
                    else None
                ),
                "codes without expiration",
            )
            if len(blank_codes) < 2:
                raise AssertionError("Expected two fresh UNUSED codes without expiration")
            for item in blank_codes[:2]:
                if not re.fullmatch(r"[A-Z0-9]{16}", item["code"]):
                    raise AssertionError(f"Unexpected code format: {item['code']}")
                if item.get("expiresAt") is not None:
                    raise AssertionError("Fresh codes should not carry an expiration time")
            code_one, code_two = blank_codes[0]["code"], blank_codes[1]["code"]

            log("public redeem success with normalized inputs")
            page.goto(f"{BASE_URL}/redeem", wait_until="networkidle")
            buyer_one = f"Buyer.One+{suffix}@gmail.com"
            page.locator("#redeem-code").fill(f"  {code_one.lower()}  ")
            page.locator("#user-email").fill(f"  {buyer_one.upper()}  ")
            page.get_by_role("button", name="提交并开始处理").click()
            result_notice = page.locator(".notice .mono.strong").nth(1)
            result_notice.wait_for()
            order_one = result_notice.inner_text().strip()
            expect_text(page.locator("body"), "TASK QUEUED")
            reserved_code = wait_for_value(
                lambda: next(
                    (
                        item
                        for item in api_json("GET", "redeem-codes", token=admin_token)
                        if item["code"] == code_one
                        and item["status"] == "RESERVED"
                        and item.get("usedAt") is None
                    ),
                    None,
                ),
                "reserved redeem code after order creation",
            )
            if not reserved_code:
                raise AssertionError("Redeemed code should stay RESERVED before completion")

            log("duplicate code rejected")
            page.goto(f"{BASE_URL}/redeem", wait_until="networkidle")
            page.locator("#redeem-code").fill(code_one)
            page.locator("#user-email").fill(f"duplicate-{suffix}@gmail.com")
            page.get_by_role("button", name="提交并开始处理").click()
            expect_text(page.locator("body"), "Invalid or already used redeem code")

            log("second redeem for task state checks")
            page.locator("#redeem-code").fill(code_two)
            page.locator("#user-email").fill(f"buyer-two-{suffix}@gmail.com")
            page.get_by_role("button", name="提交并开始处理").click()
            order_two = page.locator(".notice .mono.strong").nth(1).inner_text().strip()

            log("status lookup normalizes redeem code")
            page.goto(f"{BASE_URL}/status", wait_until="networkidle")
            page.locator("#status-lookup-code").fill(f"  {code_one.lower()}  ")
            page.get_by_role("button", name="按卡密查询进度").click()
            expect_text(page.locator("body"), order_one)
            expect_text(page.locator("body"), "bu***@gmail.com")

            log("prepare task states")
            task_one_id, order_one_id = latest_task_for_order(order_one)
            task_two_id, order_two_id = latest_task_for_order(order_two)
            db_execute(
                """
                UPDATE Task
                SET status = 'MANUAL_REVIEW',
                    lastErrorCode = 'MANUAL_REVIEW',
                    lastErrorMessage = 'Needs human review',
                    updatedAt = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (task_one_id,),
            )
            db_execute(
                """
                UPDATE "Order"
                SET status = 'MANUAL_REVIEW',
                    resultMessage = 'Waiting for human review',
                    updatedAt = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (order_one_id,),
            )
            db_execute(
                """
                UPDATE Task
                SET status = 'FAILED_RETRYABLE',
                    lastErrorCode = 'CAPTCHA',
                    lastErrorMessage = 'Temporary worker failure',
                    updatedAt = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (task_two_id,),
            )
            db_execute(
                """
                UPDATE "Order"
                SET status = 'FAILED',
                    resultMessage = 'Temporary worker failure',
                    updatedAt = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (order_two_id,),
            )

            log("admin actions visible and retry works")
            page.goto(f"{BASE_URL}/console", wait_until="networkidle")
            open_console_section(page, "任务")
            manual_row = row_for_text(page, "tasks", order_one)
            retry_row = row_for_text(page, "tasks", order_two)
            expect_text(manual_row, "MANUAL REVIEW")
            expect_text(retry_row, "FAILED RETRYABLE")
            expect_text(manual_row, "手动完成")
            expect_text(manual_row, "手动失败")
            expect_text(retry_row, "重试")
            open_console_section(page, "订单")
            expect_text(row_for_text(page, "orders", order_one), "更换成员")
            open_console_section(page, "任务")
            retry_row.get_by_role("button", name="重试").click()
            expect_text(retry_row, "PENDING")
            expect_text(retry_row, "No error")

            log("support role gating")
            page.get_by_role("button", name="退出登录").click()
            page.wait_for_url("**/console/login")
            page.locator("#login-email").fill("support@gfa.local")
            page.locator("#login-password").fill("admin123")
            page.get_by_role("button", name="进入控制台").click()
            page.wait_for_url("**/console")
            page.wait_for_load_state("networkidle")
            open_console_section(page, "母号池")
            open_panel_tab(page, "新增母号")
            expect_text(page.locator("body"), "当前角色没有新增母号权限")
            open_console_section(page, "家庭组")
            open_panel_tab(page, "新增家庭组")
            expect_text(page.locator("body"), "当前角色没有新增家庭组权限")
            open_console_section(page, "卡密")
            open_panel_tab(page, "批量生成")
            expect_text(page.locator("body"), "当前角色只能查看卡密库存")
            open_console_section(page, "任务")
            support_manual_row = row_for_text(page, "tasks", order_one)
            expect_text(support_manual_row, "MANUAL REVIEW")
            expect_text(support_manual_row, "手动完成")
            expect_text(support_manual_row, "手动失败")
            support_text = support_manual_row.inner_text()
            if "重试" in support_text:
                raise AssertionError("Support should not see retry action")
            open_console_section(page, "订单")
            if "更换成员" in page.locator("#orders").inner_text():
                raise AssertionError("Support should not see replace member action")
            open_console_section(page, "任务")

            log("support manual complete")
            page.once("dialog", lambda dialog: dialog.accept("Support completed review"))
            support_manual_row.get_by_role("button", name="手动完成").click()
            expect_text(support_manual_row, "SUCCESS")

            log("status page reflects manual completion")
            page.goto(f"{BASE_URL}/status/{order_one}", wait_until="networkidle")
            expect_text(page.locator("body"), "COMPLETED")
            expect_text(page.locator("body"), "Support completed review")
            used_code = wait_for_value(
                lambda: next(
                    (
                        item
                        for item in api_json("GET", "redeem-codes", token=admin_token)
                        if item["code"] == code_one
                        and item["status"] == "USED"
                        and item.get("usedAt")
                    ),
                    None,
                ),
                "used redeem code after order completion",
            )
            if not used_code:
                raise AssertionError("Completed order should consume the redeem code")

            page.screenshot(path=str(SCREENSHOT_DIR / "review-pass.png"), full_page=True)
        except Exception:
            page.screenshot(path=str(SCREENSHOT_DIR / "review-fail.png"), full_page=True)
            raise
        finally:
            browser.close()

    if page_errors:
        raise AssertionError(f"Unhandled page errors: {page_errors}")

    if console_errors:
        raise AssertionError(f"Browser console errors: {console_errors}")

    log(f"review passed; screenshots in {SCREENSHOT_DIR}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except TimeoutError as error:
        print(f"[review] timeout: {error}", file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        print(f"[review] failure: {error}", file=sys.stderr)
        raise SystemExit(1)
