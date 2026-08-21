import urllib.request
import json

def test_proxy():
    print("Testing proxy at http://localhost:3000/api/v1/chat/completions...")
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer zerotech13287"
    }
    payload = {
        "model": "titan-pro",
        "messages": [{"role": "user", "content": "Hello! Reply with 1 short word."}],
        "max_tokens": 16,
        "temperature": 0.7
    }
    req = urllib.request.Request("http://localhost:3000/api/v1/chat/completions", data=json.dumps(payload).encode('utf-8'), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print(f"Status: {resp.status}")
            print(f"Response: {resp.read().decode('utf-8')}")
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode('utf-8')}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    test_proxy()
