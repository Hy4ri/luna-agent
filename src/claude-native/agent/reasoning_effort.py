"""Reasoning effort normalization helper compatible with Hermes core contract."""

ALLOWED_EFFORTS = ('none', 'low', 'medium', 'high', 'xhigh', 'max')


def clamp_effort(raw, allowed=ALLOWED_EFFORTS):
    if raw is None:
        return 'medium'
    s = str(raw).strip().lower()
    if s in allowed:
        return s
    return 'medium'
