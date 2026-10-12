"""roko's backend routes for the Hermes desktop app and web dashboard.

Hermes imports this file by path (outside any package) in both of its web
backends, `hermes serve` and `hermes dashboard`, and mounts its `router` at
/api/plugins/roko. It loads the plugin package that sits next to it, so the
routes always come from the same install as the UI files. docs/ui-api.md
describes every route.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path
from types import ModuleType

_PACKAGE = "hermes_plugin_roko"
# A private name: the agent side of the same process may have loaded the
# package as `hermes_plugins.roko.hermes_plugin_roko`, and a pip install as
# `hermes_plugin_roko`; this copy must not replace either.
_ALIAS = "_hermes_plugin_roko_ui"


def _load_package() -> ModuleType:
    loaded = sys.modules.get(_ALIAS)
    if loaded is not None:
        return loaded
    root = Path(__file__).resolve().parent.parent / _PACKAGE
    init = root / "__init__.py"
    if not init.is_file():  # not a directory install: use the installed package
        return importlib.import_module(_PACKAGE)
    spec = importlib.util.spec_from_file_location(_ALIAS, init, submodule_search_locations=[str(root)])
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load the roko plugin package from {root}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_ALIAS] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(_ALIAS, None)
        raise
    return module


_package = _load_package()
_host = importlib.import_module(f"{_package.__name__}.host")
_ui = importlib.import_module(f"{_package.__name__}.ui_api")

router = _ui.build_router(_host.runtime)
