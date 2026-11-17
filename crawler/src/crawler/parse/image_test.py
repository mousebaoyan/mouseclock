import io

from PIL import Image, ImageDraw

from crawler.parse.image import PIXEL_BUDGET, picture


def png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def test_a_long_screenshot_is_cut_between_lines_into_strips_within_the_budget() -> None:
    # Bars for lines of text, 30 pixels high with 20 between them; most pixels are background.
    image = Image.new("RGB", (1000, 8000), "#f4f4f4")
    draw = ImageDraw.Draw(image)
    for top in range(10, 8000, 50):
        draw.rectangle((40, top, 400, top + 29), fill="#202020")

    strips = [Image.open(io.BytesIO(strip)) for strip in picture(png(image)).strips]

    assert all(strip.width * strip.height <= PIXEL_BUDGET for strip in strips)
    assert sum(strip.height for strip in strips) == 8000
    # No line is cut through: each strip starts on background.
    assert len(strips) > 1
    assert all(strip.getpixel((100, 0)) == (244, 244, 244) for strip in strips[1:])


def test_a_transparent_background_reads_as_the_white_page_it_sits_on() -> None:
    # Transparent pixels keep a color of their own, here black like the text.
    image = Image.new("RGBA", (600, 400), (0, 0, 0, 0))
    ImageDraw.Draw(image).rectangle((40, 40, 400, 69), fill=(0, 0, 0, 255))

    [strip] = picture(png(image)).strips

    read = Image.open(io.BytesIO(strip))
    assert (read.getpixel((10, 10)), read.getpixel((100, 50))) == ((255, 255, 255), (0, 0, 0))


def test_a_small_image_stays_whole_and_a_wide_one_is_scaled_down() -> None:
    [small] = picture(png(Image.new("RGB", (600, 400), "white"))).strips
    [wide] = picture(png(Image.new("RGB", (4000, 300), "white"))).strips

    assert Image.open(io.BytesIO(small)).size == (600, 400)
    assert Image.open(io.BytesIO(wide)).size == (2000, 150)
