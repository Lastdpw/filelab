"""Browser adapter: original FileLab logic runs locally in Pyodide."""
from __future__ import annotations
from dataclasses import asdict, dataclass, field, replace
from io import BytesIO
from pathlib import Path
import hashlib, json, math, secrets, sys, tempfile, time, types
sys.modules['pypdfium2'] = types.ModuleType('pypdfium2')
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps
from documents import MAX_PAGES, MAX_PIXELS, MAX_SOURCE_BYTES, MIB, PRESETS, Page, create_pdf, image_bytes, on_white, page_range, quality_notes, read_pages
from orientation import OrientationModel, rotate
ROOT=Path.cwd()
RUNTIME=Path(tempfile.mkdtemp(prefix='filelab-browser-'))
MODEL=OrientationModel.load()
SESSION_LIMIT=96*MIB
PDF_RASTERS={}
_base_image=Page.image

def browser_image(self,max_edge):
    if self.index is None:
        return _base_image(self,max_edge)
    key=hashlib.sha256(self.data).hexdigest()
    with Image.open(BytesIO(PDF_RASTERS[key][self.index])) as source:
        image=source.convert('RGBA')
    image.thumbnail((max_edge,max_edge),Image.Resampling.LANCZOS)
    return rotate(image,self.rotation)

Page.image=browser_image

@dataclass(frozen=True)
class PhotoAdjustments:
    preset: str = "color"
    brightness: int = 0
    contrast: int = 0
    sharpness: int = 0


@dataclass
class PhotoPage(Page):
    adjustments: PhotoAdjustments = field(default_factory=PhotoAdjustments)

    def image(self, max_edge):
        image = super().image(max_edge)
        edits = self.adjustments
        if edits == PhotoAdjustments():
            return image

        image = on_white(image)
        if edits.preset != "color":
            image = ImageOps.grayscale(image)
        if edits.preset == "scan":
            # Estimate the paper tone at low resolution to suppress broad shadows.
            size = (max(1, image.width // 8), max(1, image.height // 8))
            background = image.resize(size, Image.Resampling.BILINEAR)
            background = background.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(2))
            background = background.resize(image.size, Image.Resampling.BILINEAR)
            values = np.asarray(image, dtype=np.float32)
            values /= np.maximum(np.asarray(background), 32)
            values *= 265
            values.clip(0, 255, out=values)
            image = Image.fromarray(values.astype(np.uint8))
        if edits.brightness:
            image = ImageEnhance.Brightness(image).enhance(1 + edits.brightness / 100)
        if edits.contrast:
            image = ImageEnhance.Contrast(image).enhance(1 + edits.contrast / 100)
        if edits.sharpness:
            image = ImageEnhance.Sharpness(image).enhance(1 + edits.sharpness / 50)
        return image.convert("RGB")


def photo_adjustments(data):
    preset = data.get("preset")
    if preset not in ("color", "gray", "scan"):
        raise ValueError("Фото сүзгісін таңдаңыз.")
    levels = {}
    for name, low, high in (("brightness", -50, 50), ("contrast", -50, 50), ("sharpness", 0, 100)):
        value = data.get(name)
        if type(value) is not int or not low <= value <= high:
            raise ValueError("Өңдеу мәні рұқсат етілген аралықтан тыс.")
        levels[name] = value
    return PhotoAdjustments(preset=preset, **levels)


@dataclass
class Item:
    page: Page
    id: str = field(default_factory=lambda: secrets.token_hex(8))
    notes: list[str] = field(default_factory=list)
    orientation: str = ""
    predicted: int = 0
    vote: float = 0

    def inspect(self, orient=True):
        self.notes = quality_notes(self.page.image(500))
        if orient:
            image = on_white(Page.image(self.page, 600))
            if self.page.index is None:
                self.predicted, self.vote, confident = MODEL.predict_photo(image)
            else:
                histogram = image.convert("L").histogram()
                ink = sum(histogram[:165]) / (image.width * image.height)
                self.predicted, self.vote = MODEL.predict(image)
                confident = ink >= 0.017 and self.vote >= 0.65
            if not confident:
                self.orientation = "Қолмен тексеріңіз"
            elif self.predicted:
                self.page.rotation = (self.page.rotation - self.predicted) % 360
                self.orientation = "Бағыты түзетілді"
            else:
                self.orientation = "Бағыты дұрыс"

    def public(self):
        return dict(id=self.id, title=self.page.title, rotation=self.page.rotation,
                    notes=self.notes, orientation=self.orientation,
                    predicted=self.predicted, vote=round(self.vote, 4),
                    photo=asdict(self.page.adjustments) if isinstance(self.page, PhotoPage) else None,
                    kind="PDF" if self.page.index is not None else "Сурет")


@dataclass
class Session:
    id: str = field(default_factory=lambda: secrets.token_hex(24))
    token: str = field(default_factory=lambda: secrets.token_hex(24))
    items: list[Item] = field(default_factory=list)
    revision: int = 0
    exports: dict = field(default_factory=dict)
    touched: float = field(default_factory=time.time)

    @property
    def directory(self):
        directory = RUNTIME / self.id
        directory.mkdir(exist_ok=True)
        return directory

    def invalidate(self):
        self.revision += 1
        self.exports.clear()
        used = {item.page.path for item in self.items}
        for path in self.directory.iterdir():
            if path not in used:
                path.unlink(missing_ok=True)

    def state(self):
        return dict(pages=[item.public() for item in self.items], revision=self.revision,
                    token=self.token, sourceBytes=self.source_bytes())

    def source_bytes(self):
        return sum({id(i.page.data): len(i.page.data) for i in self.items}.values())

    def item(self, id):
        for item in self.items:
            if item.id == id:
                return item
        raise ValueError("Таңдалған бет табылмады. Беттер тізімін жаңартыңыз.")

    def add(self, name, data, target=None):
        name = name.replace("\\", "/").split("/")[-1][:180]
        suffix = Path(name).suffix.lower()
        if suffix not in {".jpg", ".jpeg", ".png", ".pdf"}:
            raise ValueError("JPG, JPEG, PNG немесе PDF файлын таңдаңыз.")
        if len(data) > MAX_SOURCE_BYTES:
            raise ValueError("Бір файлдың көлемі 64 МиБ-тан аспауы керек.")
        if self.source_bytes() + len(data) > SESSION_LIMIT:
            raise ValueError("Сессиядағы файлдардың жалпы шегі — 96 МиБ.")
        if suffix == ".pdf":
            if not data.startswith(b"%PDF-"):
                raise ValueError("Файлдың мазмұны PDF түріне сәйкес емес.")
        else:
            try:
                with Image.open(BytesIO(data)) as image:
                    expected = "PNG" if suffix == ".png" else "JPEG"
                    if image.format != expected:
                        raise ValueError("Файл кеңейтімі мен нақты сурет түрі сәйкес емес.")
                    if image.width * image.height > MAX_PIXELS:
                        raise ValueError("Суреттің ажыратымдылығы 24 мегапиксельден аспауы керек.")
                    image.verify()
            except ValueError:
                raise
            except Exception:
                raise ValueError("Сурет ашылмады: файл бүлінген немесе сурет түрі дұрыс емес.")
        path = self.directory / (secrets.token_hex(8) + suffix)
        try:
            path.write_bytes(data)
            try:
                pages = read_pages(path)
            except ValueError as error:
                if any(word in str(error) for word in ("PDF құжатында", "Құпиясөз", "МиБ", "мегапиксель")):
                    raise
                raise ValueError("Құжат ашылмады: файл бүлінген немесе пішімі қолдау таппайды.")
            except Exception:
                raise ValueError("Құжат ашылмады: файл бүлінген немесе толық жүктелмеген.")
            if len(self.items) + len(pages) - bool(target) > MAX_PAGES:
                raise ValueError(f"Бір сессияға ең көбі {MAX_PAGES} бет қосылады.")
            if target and len(pages) != 1:
                raise ValueError("Бетті ауыстыру үшін бір сурет немесе бір беттік PDF таңдаңыз.")
            added = []
            for page in pages:
                if page.index is None:
                    page = PhotoPage(page.path, page.data)
                item = Item(page)
                # Keep the disk path private; display the original upload name.
                item.inspect()
                added.append(item)
            for item in added:
                TITLES[item.id] = name if item.page.index is None else f"{name} · {item.page.index + 1}-бет"
            if target:
                position = self.items.index(self.item(target))
                TITLES.pop(self.items[position].id, None)
                self.items[position:position + 1] = added
            else:
                self.items.extend(added)
            self.invalidate()
            return len(added)
        except Exception:
            path.unlink(missing_ok=True)
            raise

    def compare(self, spec, limit):
        indices = page_range(spec, len(self.items))
        if not indices:
            raise ValueError("Алдымен кемінде бір бет қосыңыз.")
        try:
            bound = float(str(limit).replace(",", "."))
            if not math.isfinite(bound) or bound <= 0:
                raise ValueError()
        except (ValueError, TypeError):
            raise ValueError("Көлем шегін оң санмен жазыңыз. Мысалы: 0,23.")
        key = tuple(indices)
        if self.exports.get("key") != key:
            pages = [self.items[i].page for i in indices]
            variants = {mode: create_pdf(pages, mode) for mode in PRESETS}
            self.exports = dict(key=key, variants=variants)
        sizes = {mode: len(data) for mode, data in self.exports["variants"].items()}
        fits = {mode: size <= bound * MIB for mode, size in sizes.items()}
        recommended = next((mode for mode in PRESETS if fits[mode]), None)
        return dict(sizes=sizes, fits=fits, recommended=recommended,
                    revision=self.revision, count=len(indices), range=spec)


TITLES = {}

SESSION=Session()

def public_state(**extra):
    state=SESSION.state()
    for page in state['pages']:
        page['title']=TITLES.get(page['id'],page['title'])
    return dict(state,**extra)

def prune():
    used={hashlib.sha256(item.page.data).hexdigest() for item in SESSION.items if item.page.index is not None}
    for key in list(PDF_RASTERS):
        if key not in used:del PDF_RASTERS[key]

def dispatch(action,data):
    s=SESSION
    if action=='state':return public_state()
    if action=='upload':
        blob=bytes(data['data'])
        key=hashlib.sha256(blob).hexdigest()
        if data.get('rasters'):
            PDF_RASTERS[key]=[bytes(r) for r in data['rasters']]
        try:
            added=s.add(data['name'],blob,data.get('replace'))
            return public_state(added=added,errors=[])
        except Exception as error:
            reason=str(error) if isinstance(error,ValueError) else 'Құжатты өңдеу мүмкін болмады.'
            return public_state(added=0,errors=[data['name']+': '+reason])
        finally:prune()
    if action=='clear':
        s.items.clear();s.invalidate();TITLES.clear();PDF_RASTERS.clear()
    elif action=='compare':return s.compare(data.get('range',''),data.get('limit'))
    elif action=='reorder':
        ids=data.get('ids',[])
        if len(ids)!=len(s.items) or set(ids)!={p.id for p in s.items}:raise ValueError('Беттер реті сәйкес емес.')
        s.items=[s.item(id) for id in ids];s.invalidate()
    elif action in ('rotate','delete','quality','orient'):
        item=s.item(data['id'])
        if action=='delete':
            s.items.remove(item);TITLES.pop(item.id,None)
        elif action=='rotate':
            if data['angle'] not in (-90,90):raise ValueError('Бұру қадамы — 90°.')
            item.page.rotation=(item.page.rotation+data['angle'])%360;item.orientation='Қолмен бұрылды'
        else:item.inspect(orient=action=='orient')
        s.invalidate();prune()
    elif action=='photo-filter':
        item = s.item(data['id'])
        if not isinstance(item.page, PhotoPage):
            raise ValueError("Фото сүзгілері JPG және PNG суреттеріне қолданылады.")
        edits = photo_adjustments(data)
        if edits != item.page.adjustments:
            item.page = replace(item.page, adjustments=edits)
            item.inspect(orient=False)
            s.invalidate()
    elif action=='image':
        item=s.item(data['id'])
        page = item.page
        if data.get('original'):
            page = replace(page, rotation=0)
            if isinstance(page, PhotoPage):
                page.adjustments = PhotoAdjustments()
        kind=data.get('format')
        if kind in ('png','jpg'):return dict(bytes=image_bytes(page,'.'+kind),mime='image/png' if kind=='png' else 'image/jpeg')
        stream=BytesIO();on_white(page.image(180 if data.get('thumb') else 1000)).save(stream,'JPEG',quality=88)
        return dict(bytes=stream.getvalue(),mime='image/jpeg')
    elif action=='pdf':
        if int(data.get('revision',-1))!=s.revision:raise ValueError('Беттер өзгерді. Көлемдерді қайта салыстырыңыз.')
        key=tuple(page_range(data.get('range',''),len(s.items)))
        if key!=s.exports.get('key'):raise ValueError('Бет аралығы өзгерді. Көлемдерді қайта салыстырыңыз.')
        if data.get('mode') not in PRESETS:raise ValueError('PDF режимін таңдаңыз.')
        return dict(bytes=s.exports['variants'][data['mode']],mime='application/pdf')
    elif action=='evaluate':
        matrix=[[0]*4 for _ in range(4)]
        rows=[]
        for fixture in data['fixtures']:
            with Image.open(BytesIO(bytes(fixture['data']))) as image:
                angle,vote=MODEL.predict(image)
            matrix[fixture['expected']//90][angle//90]+=1
            rows.append(dict(name=fixture['name'],expected=fixture['expected'],predicted=angle,vote=vote))
        return dict(correct=sum(matrix[i][i] for i in range(4)),total=len(rows),matrix=matrix,rows=rows)
    else:raise ValueError('Әрекет табылмады.')
    return public_state()
