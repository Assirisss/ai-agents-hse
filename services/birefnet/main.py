"""BiRefNet runs on Runpod GPU workers. This module only declares the endpoint."""

from runpod_flash import CudaVersion, Endpoint, GpuGroup


@Endpoint(
    name="graphite-birefnet-worker",
    gpu=GpuGroup.AMPERE_16,
    workers=(0, 1),
    idle_timeout=1,
    flashboot=True,
    min_cuda_version=CudaVersion.V12_8,
    execution_timeout_ms=180_000,
    dependencies=[
        "transformers==4.46.3",
        "timm==1.0.11", "kornia==0.7.4", "einops==0.8.0",
        "Pillow>=11.3,<13", "safetensors>=0.4.5,<1",
        # Explicit lightweight dependencies support a --no-deps build without
        # downloading CUDA/PyTorch wheels on the deployment computer.
        "huggingface-hub==0.36.2", "tokenizers==0.20.3", "kornia-rs==0.2.0",
        "filelock", "packaging", "PyYAML", "regex", "requests", "tqdm",
        "fsspec", "typing-extensions", "certifi", "charset-normalizer", "idna", "urllib3",
    ],
    env={"HF_HUB_DISABLE_TELEMETRY": "1"},
)
async def remove_background(input_data: dict) -> dict:
    # Flash dev serializes this body, so keep imports and model cache inside it.
    import base64
    from binascii import Error as Base64Error
    from io import BytesIO
    import warnings

    from PIL import Image, ImageChops, ImageOps, UnidentifiedImageError
    import torch
    from torchvision import transforms
    from transformers import AutoModelForImageSegmentation

    model_id = "ZhengPeng7/BiRefNet"
    revision = "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4"
    encoded = input_data.get("image_base64")
    if not isinstance(encoded, str) or not 0 < len(encoded) <= 8 * 1024 * 1024:
        return {"error": "Expected image_base64, up to 6 MiB decoded."}
    if input_data.get("mime_type") not in {"image/jpeg", "image/png", "image/webp"}:
        return {"error": "Expected JPEG, PNG or WebP."}
    try:
        data = base64.b64decode(encoded, validate=True)
        if len(data) > 6 * 1024 * 1024:
            return {"error": "Image exceeds 6 MiB."}
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as source:
                if source.format not in {"JPEG", "PNG", "WEBP"} or getattr(source, "is_animated", False):
                    return {"error": "Expected a still JPEG, PNG or WebP."}
                if source.width * source.height > 40_000_000:
                    return {"error": "Image exceeds 40 megapixels."}
                image = ImageOps.exif_transpose(source).convert("RGBA")
        # Bound PNG/base64 output below Runpod's payload limit; keep aspect ratio.
        image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
    except (Base64Error, ValueError, OSError, UnidentifiedImageError,
            Image.DecompressionBombError, Image.DecompressionBombWarning):
        return {"error": "Invalid image."}

    if not torch.cuda.is_available():
        raise RuntimeError("BiRefNet requires a CUDA GPU on the Runpod worker.")
    global _BIREFNET_STATE
    try:
        state = _BIREFNET_STATE
    except NameError:
        model = AutoModelForImageSegmentation.from_pretrained(
            model_id, revision=revision, code_revision=revision,
            trust_remote_code=True, use_safetensors=True,
        ).eval().to(device="cuda", dtype=torch.float16)
        transform = transforms.Compose([
            transforms.Resize((1024, 1024)), transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])
        state = _BIREFNET_STATE = (model, transform)
    model, transform = state
    inputs = transform(image.convert("RGB")).unsqueeze(0).to(device="cuda", dtype=torch.float16)
    with torch.inference_mode():
        prediction = model(inputs)[-1].sigmoid()[0].squeeze().float().cpu()
    mask = transforms.ToPILImage()(prediction).resize(image.size, Image.Resampling.BILINEAR)
    image.putalpha(ImageChops.multiply(image.getchannel("A"), mask))
    output = BytesIO()
    image.save(output, format="PNG")
    return {
        "image_base64": base64.b64encode(output.getvalue()).decode("ascii"),
        "mime_type": "image/png", "width": image.width, "height": image.height,
        "model": model_id, "revision": revision,
    }
