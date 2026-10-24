"""Configuration loading."""

def load_config(overrides=None, env="dev"):
    cfg = {"name": "shelf", "retries": 3, "env": env}
    if overrides:
        cfg.update(overrides)
    return cfg
