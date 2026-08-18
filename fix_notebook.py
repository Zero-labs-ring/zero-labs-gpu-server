import json, re

path = 'notebooks/active/ultra_notebook.ipynb'
with open(path, 'r', encoding='utf-8') as f:
    nb = json.load(f)

cells = nb['cells']
fixed_cells = []

for cell in cells:
    if cell['cell_type'] != 'code':
        fixed_cells.append(cell)
        continue

    src = ''.join(cell['source'])

    # ── FIX 1: pin huggingface_hub in install_converter_deps ──────────────────
    if 'pip-install-converter-deps' in src and "huggingface_hub>=0.24" in src:
        src = src.replace("'huggingface_hub>=0.24'", "'huggingface_hub==0.25.2'")
        print("FIX 1 applied: pinned huggingface_hub==0.25.2 in install_converter_deps")

    # ── FIX 2: add hf_hub downgrade before push ───────────────────────────────
    if 'push_to_hub' in src and 'api.upload_file' in src and 'XetProgressReporter' not in src:
        old_try = 'try:\n            tok = HF_TOKEN or get_hf_token()\n            from huggingface_hub import HfApi'
        new_try = (
            'try:\n'
            '            # FIX v4: downgrade before push to avoid XetProgressReporter ImportError\n'
            '            import subprocess as _sp\n'
            '            _sp.run([sys.executable, "-m", "pip", "install", "-q", "huggingface_hub==0.25.2"],\n'
            '                    check=False, capture_output=True)\n'
            '            tok = HF_TOKEN or get_hf_token()\n'
            '            from huggingface_hub import HfApi'
        )
        if old_try in src:
            src = src.replace(old_try, new_try)
            print("FIX 2 applied: added hf_hub downgrade before push")
        else:
            print("FIX 2: pattern not found, skipping")

    # ── FIX 3: server configs + inference timeout ─────────────────────────────
    if 'start_llama_server' in src and 'dual GPU, 4 slots' in src:
        # 3a: timeout
        src = src.replace(
            'def test_inference(port, timeout=120):',
            'def test_inference(port, timeout=180):'
        )
        print("FIX 3a applied: inference timeout 120->180s")

        # 3b: replace configs block
        old_configs = (
            '    configs = [\n'
            '        {\n'
            '            "desc":    "dual GPU, 4 slots, ctx=8k, flash-attn auto",\n'
            '            "ngl":     999, "parallel": 4, "ctx": 8192, "batch": 512,\n'
            '            "flash":   "--flash-attn auto",\n'
            '            "split":   "--tensor-split 0.5,0.5",\n'
            '        },\n'
            '        {\n'
            '            "desc":    "dual GPU, 2 slots, ctx=8k, flash-attn off",\n'
            '            "ngl":     999, "parallel": 2, "ctx": 8192, "batch": 256,\n'
            '            "flash":   "--flash-attn off",\n'
            '            "split":   "--tensor-split 0.5,0.5",\n'
            '        },\n'
            '        {\n'
            '            "desc":    "single GPU, 4 slots, ctx=8k, flash-attn auto",\n'
            '            "ngl":     999, "parallel": 4, "ctx": 8192, "batch": 256,\n'
            '            "flash":   "--flash-attn auto",\n'
            '            "split":   "--split-mode none --main-gpu 0",\n'
            '        },\n'
            '        {\n'
            '            "desc":    "single GPU, 1 slot, ctx=4k, flash-attn off (last resort)",\n'
            '            "ngl":     999, "parallel": 1, "ctx": 4096, "batch": 128,\n'
            '            "flash":   "--flash-attn off",\n'
            '            "split":   "--split-mode none --main-gpu 0",\n'
            '        },\n'
            '    ]'
        )
        new_configs = (
            '    # v4 FIX: --override-tensor pins GatedDeltaNet SSM layers to CPU.\n'
            '    # This prevents the dual-GPU inference hang caused by the CUDA\n'
            '    # chunked-prefill kernel gap in the GatedDeltaNet op.\n'
            '    # Single-GPU removed: 16.8GB model always OOMs on a single 16GB T4.\n'
            '    _SSM = (\n'
            '        \'--override-tensor "blk\\\\..*\\\\.ssm_.*=CPU" \'\n'
            '        \'--override-tensor "blk\\\\..*\\\\.attn_gate.*=CPU"\'\n'
            '    )\n'
            '    configs = [\n'
            '        {\n'
            '            "desc":    "dual GPU, 2 slots, ctx=6k, flash-attn off + SSM CPU",\n'
            '            "ngl":     999, "parallel": 2, "ctx": 6144, "batch": 256,\n'
            '            "flash":   "--flash-attn off",\n'
            '            "split":   f"--split-mode layer --tensor-split 0.5,0.5 {_SSM}",\n'
            '        },\n'
            '        {\n'
            '            "desc":    "dual GPU, 1 slot, ctx=4k, flash-attn off + SSM CPU",\n'
            '            "ngl":     999, "parallel": 1, "ctx": 4096, "batch": 128,\n'
            '            "flash":   "--flash-attn off",\n'
            '            "split":   f"--split-mode layer --tensor-split 0.5,0.5 {_SSM}",\n'
            '        },\n'
            '        {\n'
            '            "desc":    "dual GPU row-split, 1 slot, ctx=4k (no SSM fix, last resort)",\n'
            '            "ngl":     999, "parallel": 1, "ctx": 4096, "batch": 128,\n'
            '            "flash":   "--flash-attn off",\n'
            '            "split":   "--tensor-split 0.5,0.5",\n'
            '        },\n'
            '    ]'
        )
        if old_configs in src:
            src = src.replace(old_configs, new_configs)
            print("FIX 3b applied: server configs replaced with SSM-CPU-pinned dual-GPU configs")
        else:
            print("FIX 3b: configs block not found verbatim — check escaping")
            # Try a looser match
            if '"dual GPU, 4 slots, ctx=8k, flash-attn auto"' in src:
                print("  Found partial match, attempting regex replace...")
                src = re.sub(
                    r'configs = \[.*?\]',
                    new_configs,
                    src,
                    flags=re.DOTALL,
                    count=1
                )
                print("  Regex replace done")

    cell['source'] = [src]
    fixed_cells.append(cell)

nb['cells'] = fixed_cells

out_path = 'notebooks/active/ultra_notebook.ipynb'
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(nb, f, indent=1, ensure_ascii=False)
print(f"\nSaved fixed notebook to: {out_path}")

# Verify fixes
with open(out_path, 'r', encoding='utf-8') as f:
    final = f.read()

checks = {
    'huggingface_hub==0.25.2': 'FIX 1 (pin hf_hub)',
    'XetProgressReporter': 'FIX 2 comment',
    'timeout=180': 'FIX 3a (timeout)',
    'SSM_CPU / _SSM var': '_SSM',
    'split-mode layer': 'FIX 3b (split-mode layer)',
}
print("\n=== VERIFICATION ===")
for val, label in checks.items():
    found = val in final
    print(f"  {'OK' if found else 'MISSING'}: {label} -> '{val}'")
