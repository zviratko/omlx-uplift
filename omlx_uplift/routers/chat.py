"""Native Chat surface API (NAT-3 scaffold; NAT-4 fills it).

Design frozen in NAT-1 (out/NAT-1.*): deep-chat web component vendored
under static/vendor/, talking to public /v1/* same-origin; uplift's own
routes serve only (a) the one-time API-key handout behind require_admin —
equal exposure surface to classic's template injection (classic
routes.py chat_page docstring: 'API key is injected into the template
context so the chat page can auto-set it in localStorage'), and (b) chat
history storage (NAT-1 probe verdict item 7: server store feeding
loadHistory/getMessages).

This scaffold registers the stubs so the route-set test, frontend glue and
i18n skeleton land together (NAT-3). Real handlers arrive with NAT-4.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException

from .base import api_router, require_admin


def _stub(name: str):
    def handler(is_admin: bool = Depends(require_admin)):
        raise HTTPException(
            status_code=501,
            detail=f"native chat surface '{name}': not implemented yet (NAT-3 scaffold)")
    handler.__name__ = name
    return handler


@api_router.get("/chat/key")
async def chat_key(is_admin: bool = Depends(require_admin)):
    """Admin-gated one-time API key handout for the native chat component
    (NAT-1 auth verdict: session gate, NOT template injection)."""
    raise HTTPException(
        status_code=501,
        detail="native chat surface 'chat_key': not implemented yet (NAT-3 scaffold)")


chat_history = _stub("chat_history_get")
chat_history_save = _stub("chat_history_save")

api_router.get("/chat/history")(chat_history)
api_router.post("/chat/history")(chat_history_save)
