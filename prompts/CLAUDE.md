# Zero GPU Server — AI Agent Context

@AGENTS.md

---

## 🚨 CRITICAL: Kaggle 2xT4 GPU Push — DO NOT GET WRONG

### The Problem
`enable_gpu: true` alone defaults Kaggle to **P100**, NOT 2xT4.
`accelerator: "GPU_T4_X2"` is **IGNORED** by Kaggle — do not use it.

### The Fix — ALWAYS use `machine_shape`

The **only** field that forces 2xT4 on Kaggle is:

```json
"machine_shape": "NvidiaTeslaT4"
```

### Correct `kernel-metadata.json` for 2xT4

```json
{
  "id": "mohideensayed/zero-pro-server",
  "title": "Zero Pro Server",
  "code_file": "zero_pro_v6.ipynb",
  "language": "python",
  "kernel_type": "notebook",
  "is_private": true,
  "enable_gpu": true,
  "enable_tpu": false,
  "enable_internet": true,
  "keywords": [],
  "dataset_sources": [],
  "kernel_sources": [],
  "competition_sources": [],
  "model_sources": [],
  "machine_shape": "NvidiaTeslaT4"
}
```

### Push Command

```bash
python -m kaggle kernels push -p e:\zero-gpu-server\push_dir
```

> Note: Use `python -m kaggle` not `kaggle` — the CLI may not be in PATH on Windows.

### Verify GPU in Notebook

After run starts, confirm 2xT4 with:
```python
!nvidia-smi
```
You should see **2 separate Tesla T4** devices (GPU 0 and GPU 1).

---

## Project: Zero GPU Server

- **Stack**: Next.js (frontend) + Python (Kaggle kernel management)
- **Kaggle kernel**: `mohideensayed/zero-pro-server`
- **Notebook to push**: `push_dir/zero_pro_v6.ipynb`
- **Push dir**: `e:\zero-gpu-server\push_dir\`
- **GPU**: 2x NVIDIA Tesla T4 (free Kaggle tier)
