#!/usr/bin/env python3
"""One-shot: add the uplift.chat.speak_route* keys to every locale file.

The chat's Speech section gained a door selector (this board's voice engine vs
the server's own POST /v1/audio/speech), so the label, both option names and
the hint need real translations: a value left identical to en trips the
brand/unit whitelist rule in tests/test_i18n_parity.py.
"""
import json
import pathlib

T = {
 "en":     dict(route="Speech API", uplift="Uplift engine", vanilla="Vanilla API",
                hint="Ask for the audio from this board, or from the server itself (POST /v1/audio/speech)"),
 "cs":     dict(route="Rozhraní řeči", uplift="Motor Uplift", vanilla="Rozhraní vanilla",
                hint="Vyberte, kdo audio vytvoří: tato deska, nebo samotný server (POST /v1/audio/speech)"),
 "es":     dict(route="API de voz", uplift="Motor Uplift", vanilla="API nativa",
                hint="Elige quién genera el audio: este panel o el propio servidor (POST /v1/audio/speech)"),
 "fr":     dict(route="API vocale", uplift="Moteur Uplift", vanilla="API native",
                hint="Choisissez qui produit l'audio : ce tableau ou le serveur lui-même (POST /v1/audio/speech)"),
 "ja":     dict(route="音声API", uplift="Upliftエンジン", vanilla="バニラAPI",
                hint="音声の生成元を選びます: このボード、またはサーバー本体 (POST /v1/audio/speech)"),
 "ko":     dict(route="음성 API", uplift="Uplift 엔진", vanilla="바닐라 API",
                hint="오디오를 어디에서 만들지 선택합니다: 이 보드 또는 서버 자체(POST /v1/audio/speech)"),
 "pt-BR":  dict(route="API de voz", uplift="Motor Uplift", vanilla="API nativa",
                hint="Escolha quem gera o áudio: este painel ou o próprio servidor (POST /v1/audio/speech)"),
 "ru":     dict(route="API речи", uplift="Движок Uplift", vanilla="Нативное API",
                hint="Выберите, кто создаёт аудио: эта панель или сам сервер (POST /v1/audio/speech)"),
 "zh-TW":  dict(route="語音 API", uplift="Uplift 引擎", vanilla="原生 API",
                hint="選擇音訊由誰產生: 本面板, 還是伺服器本身 (POST /v1/audio/speech)"),
 "zh":     dict(route="语音 API", uplift="Uplift 引擎", vanilla="原生 API",
                hint="选择音频由谁生成: 本面板, 还是服务器本身 (POST /v1/audio/speech)"),
}

KEYS = [("uplift.chat.speak_route", "route"),
        ("uplift.chat.speak_route_uplift", "uplift"),
        ("uplift.chat.speak_route_vanilla", "vanilla"),
        ("uplift.chat.speak_route_hint", "hint")]

base = pathlib.Path(__file__).resolve().parents[1] / "omlx_uplift" / "locales"
for lang, vals in T.items():
    p = base / f"{lang}.json"
    lines = p.read_text(encoding="utf-8").rstrip("\n").split("\n")
    have = [i for i, ln in enumerate(lines) if '"uplift.chat.speak_' in ln]
    if not have:
        raise SystemExit(f"{lang}: no uplift.chat.speak_* anchor line to follow")
    idx = max(have)
    doc_now = json.loads(p.read_text(encoding="utf-8"))
    # never re-add a key the file already carries (re-running is harmless)
    block = [f'  {json.dumps(k, ensure_ascii=False)}: '
             f'{json.dumps(vals[field], ensure_ascii=False)}'
             for k, field in KEYS if k not in doc_now]
    if not block:
        print(f"{lang}: already carries all {len(KEYS)} keys, untouched")
        continue
    out = lines[:idx + 1] + [ln + "," for ln in block] + lines[idx + 1:]
    p.write_text("\n".join(out) + "\n", encoding="utf-8")
    doc = json.loads(p.read_text(encoding="utf-8"))   # must still parse
    missing = [k for k, _ in KEYS if k not in doc]
    print(f"{lang}: +{len(block)} keys after line {idx + 1}"
          + (f"  MISSING {missing}" if missing else ""))
