"""Local file import, raster previews, PDF assembly and export."""

from contextlib import closing
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from tempfile import NamedTemporaryFile

import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageOps
from pypdf import PdfReader, PdfWriter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

from orientation import rotate


MIB = 1024 * 1024
MAX_PAGES = 40
MAX_SOURCE_BYTES = 64 * MIB
MAX_PIXELS = 24_000_000
PRESETS = {
    "original": (2400, 94),
    "standard": (1550, 82),
    "small": (1050, 66),
}


@dataclass
class Page:
    path: Path
    data: bytes
    index: int | None = None
    rotation: int = 0
    note: str = ""

    @property
    def title(self) -> str:
        return self.path.name if self.index is None else f"{self.path.name} · {self.index + 1}-бет"

    def image(self, max_edge: int) -> Image.Image:
        if self.index is None:
            with Image.open(BytesIO(self.data)) as original:
                image = ImageOps.exif_transpose(original).convert("RGBA")
        else:
            with pdfium.PdfDocument(self.data) as document:
                with closing(document[self.index]) as page:
                    scale = max_edge / max(page.get_size())
                    with closing(page.render(scale=scale)) as bitmap:
                        image = bitmap.to_pil().copy().convert("RGBA")
        image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
        return rotate(image, self.rotation)


def read_pages(path: Path) -> list[Page]:
    path = path.resolve()
    if path.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError("Бір файлдың көлемі 64 МиБ-тан аспауы керек.")
    data = path.read_bytes()
    if path.suffix.lower() == ".pdf":
        pdf = PdfReader(BytesIO(data))
        if pdf.is_encrypted:
            raise ValueError("Құпиясөзбен қорғалған PDF қолдау таппайды.")
        count = len(pdf.pages)
        if not 1 <= count <= MAX_PAGES:
            raise ValueError(f"PDF құжатында 1–{MAX_PAGES} бет болуы керек.")
        return [Page(path, data, index) for index in range(count)]
    with Image.open(BytesIO(data)) as image:
        if image.format not in {"JPEG", "PNG"}:
            raise ValueError("JPG, PNG және PDF файлдарын таңдаңыз.")
        if image.width * image.height > MAX_PIXELS:
            raise ValueError("Суреттің ажыратымдылығы 24 мегапиксельден аспауы керек.")
        image.verify()
    return [Page(path, data)]


def on_white(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    result = Image.new("RGB", rgba.size, "white")
    result.paste(rgba, mask=rgba.getchannel("A"))
    return result


def quality_notes(image: Image.Image) -> list[str]:
    image = on_white(image)
    image.thumbnail((500, 500))
    gray = np.asarray(image.convert("L"), dtype=np.float32)
    notes = []
    if np.percentile(gray, 80) < 128:
        notes.append("Тым қараңғы")
    if min(gray.shape) >= 3:
        center = gray[1:-1, 1:-1]
        laplacian = gray[:-2, 1:-1] + gray[2:, 1:-1] + gray[1:-1, :-2] + gray[1:-1, 2:] - 4 * center
        if np.std(laplacian) < 6:
            notes.append("Бұлыңғыр немесе бөлшегі аз")
    return notes


def _raster_pdf_page(image: Image.Image, quality: int) -> bytes:
    jpeg = BytesIO()
    on_white(image).save(jpeg, format="JPEG", quality=quality, optimize=True)
    jpeg.seek(0)
    max_width, max_height = (595, 842) if image.height >= image.width else (842, 595)
    scale = min(max_width / image.width, max_height / image.height)
    width, height = image.width * scale, image.height * scale
    stream = BytesIO()
    canvas = Canvas(stream, pagesize=(width, height), pageCompression=1)
    canvas.drawImage(ImageReader(jpeg), 0, 0, width=width, height=height)
    canvas.showPage()
    canvas.save()
    return stream.getvalue()


def create_pdf(pages: list[Page], preset: str) -> bytes:
    if not pages:
        raise ValueError("Кемінде бір бет қосыңыз.")
    edge, quality = PRESETS[preset]
    writer = PdfWriter()
    readers = {}
    for page in pages:
        if preset == "original" and page.index is not None:
            key = id(page.data)
            if key not in readers:
                readers[key] = PdfReader(BytesIO(page.data))
            copied = writer.add_page(readers[key].pages[page.index])
            copied.rotate(page.rotation)
        else:
            raster = _raster_pdf_page(page.image(edge), quality)
            writer.add_page(PdfReader(BytesIO(raster)).pages[0])
    stream = BytesIO()
    writer.write(stream)
    return stream.getvalue()


def image_bytes(page: Page, extension: str) -> bytes:
    image = page.image(2400)
    stream = BytesIO()
    if extension.lower() == ".png":
        image.save(stream, format="PNG")
    else:
        on_white(image).save(stream, format="JPEG", quality=94, optimize=True)
    return stream.getvalue()


def page_range(spec: str, count: int) -> list[int]:
    if not spec.strip():
        return list(range(count))
    result = []
    for part in spec.split(","):
        edges = part.strip().replace("–", "-").split("-")
        if not 1 <= len(edges) <= 2 or not all(edge.strip().isdecimal() for edge in edges):
            raise ValueError("Беттерді 1, 3-5 түрінде жазыңыз.")
        first, last = int(edges[0]), int(edges[-1])
        if not 1 <= first <= last <= count:
            raise ValueError(f"Бет нөмірлері 1 мен {count} аралығында болуы керек.")
        result.extend(range(first - 1, last))
    return list(dict.fromkeys(result))


def save_new(path: Path, data: bytes, source_paths: set[Path]):
    target = path.resolve()
    if target in source_paths:
        raise ValueError("Бастапқы файлды сақтау үшін басқа атау таңдаңыз.")
    temporary = None
    try:
        with NamedTemporaryFile(dir=target.parent, delete=False) as file:
            temporary = Path(file.name)
            file.write(data)
        temporary.replace(target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
