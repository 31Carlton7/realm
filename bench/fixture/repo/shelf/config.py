"""Configuration loading."""

def load_config(overrides=None):
    cfg = {"name": "shelf", "retries": 3}
    if overrides:
        cfg.update(overrides)
    return cfg
