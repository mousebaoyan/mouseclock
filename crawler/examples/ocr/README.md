# 图片文字识别示例

- `input.png`：用 Pillow 绘制的三行合成中文图片；`output.txt` 是 RapidOCR 的完整输出。
- `test.jpg`：一页通知图片；`test-output.txt` 是图片识别函数的完整输出，未人工修正。

在 `crawler/` 目录运行下面的命令，可以重新生成 `test-output.txt`：

```powershell
uv run python -c "from pathlib import Path; from crawler.parse.image import image_text; image = Path('examples/ocr/test.jpg'); Path('examples/ocr/test-output.txt').write_text(image_text(image.read_bytes()) + chr(10), encoding='utf-8')"
```
