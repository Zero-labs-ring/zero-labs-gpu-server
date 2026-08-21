import urllib.request
import json
import time

BASE_URL = "http://localhost:3000"

def test_endpoint(name, url, method="GET", payload=None):
    print(f"\n--- Testing {name} ({method} {url}) ---")
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8') if payload else None,
        headers={"Content-Type": "application/json"} if payload else {}
    )
    req.get_method = lambda: method
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            status = resp.status
            body = resp.read().decode('utf-8')
            try:
                data = json.loads(body)
                print(f"Status: {status} OK")
                return True, data
            except Exception:
                print(f"Status: {status} (Non-JSON text)")
                return True, body
    except urllib.error.HTTPError as e:
        err = e.read().decode('utf-8')
        print(f"HTTP Error {e.code}: {err}")
        return False, err
    except Exception as e:
        print(f"Connection Error: {e}")
        return False, str(e)

def main():
    print("==================================================")
    print("ZERO LABS ORCHESTRATOR & DASHBOARD TEST SUITE")
    print("==================================================")
    
    # 1. Test GET /api/accounts
    ok, accounts = test_endpoint("Accounts & Quota API", f"{BASE_URL}/api/accounts")
    if ok and isinstance(accounts, list):
        print(f"Fetched {len(accounts)} accounts successfully.")
        if accounts:
            sample = accounts[0]
            print(f"Sample Account: @{sample.get('username') or sample.get('kaggle_username')}")
            print(f" - Label: {sample.get('label')}")
            print(f" - Weekly Hours Used: {sample.get('weekly_hours_used')}h")
            print(f" - Rotations: {sample.get('rotation_count')}")
            print(f" - Active: {sample.get('is_active')}")
    
    # 2. Test GET /api/stealth (Rotation Engine)
    ok, stealth = test_endpoint("Rotation Engine API (Stealth)", f"{BASE_URL}/api/stealth")
    if ok and isinstance(stealth, list):
        print(f"Fetched {len(stealth)} ranked accounts for rotation.")
        for idx, acc in enumerate(stealth[:3]):
            print(f" #{idx+1} @{acc.get('username')}: {acc.get('weekly_hours_used', 0)}h used, {acc.get('hours_remaining', 0)}h remaining, {acc.get('rotation_count', 0)} rotations")

    # 3. Test GET /api/endpoints
    ok, ep = test_endpoint("Endpoints Health API", f"{BASE_URL}/api/endpoints")
    if ok and isinstance(ep, dict):
        print(f"Endpoints Status: {ep}")

    # 4. Test GET /api/sessions
    ok, sessions = test_endpoint("Sessions & Nodes API", f"{BASE_URL}/api/sessions")
    if ok and isinstance(sessions, list):
        print(f"Active GPU sessions: {len(sessions)}")

    # 5. Test Orchestrator Simulation Tick /api/cron/orchestrate
    ok, tick = test_endpoint("Orchestrator Scheduler Tick", f"{BASE_URL}/api/cron/orchestrate")
    if ok and isinstance(tick, dict):
        print(f"Orchestrator Tick Result: {json.dumps(tick, indent=2)}")

    print("\n==================================================")
    print("ALL TESTS COMPLETED")
    print("==================================================")

if __name__ == "__main__":
    main()
