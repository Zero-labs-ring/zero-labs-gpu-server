import urllib.request
import json
import os

SUPABASE_URL = 'https://blooumzjgjqrerghqwwa.supabase.co'
SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsb291bXpqZ2pxcmVyZ2hxd3dhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4Njk4NTQ0NCwiZXhwIjoyMTAyNTYxNDQ0fQ.SKEkYvzFtNpgNezga8_p8fAWSZfNUm0MfUlF9XcbRo4'

def inspect_db():
    print("=== INSPECTING SUPABASE gateway_urls & sessions ===")
    headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}'
    }
    
    # 1. gateway_urls
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/gateway_urls?select=*", headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            print(f"gateway_urls rows ({len(data)}):")
            for r in data:
                print(f" - Model: {r.get('model')}, Healthy: {r.get('is_healthy')}, URL: {r.get('tunnel_url')}, Last Seen: {r.get('last_seen_at')}")
    except Exception as e:
        print(f"Error fetching gateway_urls: {e}")

    # 2. sessions
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/sessions?select=id,model,status,kernel_slug,started_at,endpoints&order=started_at.desc&limit=5", headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            print(f"\nRecent sessions ({len(data)}):")
            for s in data:
                print(f" - ID: {s.get('id')}, Model: {s.get('model')}, Status: {s.get('status')}, Started: {s.get('started_at')}, Endpoints: {s.get('endpoints')}")
    except Exception as e:
        print(f"Error fetching sessions: {e}")

if __name__ == '__main__':
    inspect_db()
