"""이 폴더의 모든 Strategy 하위 클래스를 자동 등록한다. 파일만 추가하면 됨."""
import importlib
import inspect
import pkgutil

from ..strategy import Strategy

REGISTRY: dict[str, type[Strategy]] = {}

for m in pkgutil.iter_modules(__path__):
    if m.name.startswith("_"):
        continue
    mod = importlib.import_module(f"{__name__}.{m.name}")
    for _, obj in inspect.getmembers(mod, inspect.isclass):
        if issubclass(obj, Strategy) and obj is not Strategy and obj.__module__ == mod.__name__:
            REGISTRY[obj.name] = obj


def get(name: str) -> type[Strategy]:
    if name not in REGISTRY:
        raise KeyError(f"전략 '{name}' 없음. 사용 가능: {sorted(REGISTRY)}")
    return REGISTRY[name]
