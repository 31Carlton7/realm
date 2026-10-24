"""Configuration loading."""

def load_config(overrides=None):
    cfg = {"name": "shelf", "retries": 5}
    if overrides:
        cfg.update(overrides)
    return cfg
