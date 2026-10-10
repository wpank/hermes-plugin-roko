"""Directory-install entry point for the roko Hermes plugin.

`hermes plugins install` places this repository at ~/.hermes/plugins/roko/
and imports this file as the package `hermes_plugins.roko`. The plugin itself
lives in the `hermes_plugin_roko` package next to it; a pip install loads that
package directly through the `hermes_agent.plugins` entry point.
"""

from __future__ import annotations

if __package__:
    from .hermes_plugin_roko import __version__, register

    __all__ = ["__version__", "register"]
