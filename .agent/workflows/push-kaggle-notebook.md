---
description: How to push the Zero Pro Server notebook to Kaggle with 2xT4 GPU
---

# 🚨 CRITICAL RULE — NEVER SKIP THIS

The field `"machine_shape": "NvidiaTeslaT4"` is the **only** way to get 2xT4 on Kaggle.
- `enable_gpu: true` alone → gives **P100** (wrong)
- `accelerator: "GPU_T4_X2"` → **IGNORED** by Kaggle (wrong)
- `"machine_shape": "NvidiaTeslaT4"` → gives **2x Tesla T4** ✅

---

## Steps

1. Ensure `push_dir/kernel-metadata.json` looks exactly like this:

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

2. Ensure the notebook file `push_dir/zero_pro_v6.ipynb` is up to date.

// turbo
3. Push to Kaggle:

```powershell
python -m kaggle kernels push -p e:\zero-gpu-server\push_dir
```

4. Verify push succeeded — output should say `Kernel version X successfully pushed`.

5. To verify 2xT4 is active, open the kernel on Kaggle and run `!nvidia-smi` — you should see 2 Tesla T4 GPUs.
