"""Production static storage with consistent ES-module URLs."""

from whitenoise.storage import CompressedManifestStaticFilesStorage


class StaticFilesStorage(CompressedManifestStaticFilesStorage):
    # Rewrite relative JS imports during collectstatic, just like CSS URLs.
    # Otherwise the page's hashed Datastar script and Rocket's unhashed import
    # instantiate separate runtimes, freezing the browser with competing effects.
    support_js_module_import_aggregation = True
