#!/usr/bin/env python3
"""One-shot: insert the uplift.voices.say_{limits,chunk,mb}* keys in place.

SAY-6 gave the macOS voices panel two number fields (characters per spoken
piece, MB of audio a reply may reach). Locale files are NOT key-sorted here, so
this inserts after the existing say_hint key and leaves every other line
untouched; tests/test_i18n_parity.py rejects a non-en value byte-identical to
en unless every word is a brand/unit token, so each locale carries a real
translation.
"""
import json
import pathlib

T = {
 "en": dict(
    limits="A long reply is spoken in pieces and stitched back into one file, so the "
           "server holds a piece rather than the whole answer.",
    chunk="Characters per piece",
    chunk_hint="0 keeps the whole reply in one call. Each extra piece costs about a "
               "second of setup.",
    mb="Largest reply (MB of audio)",
    mb_hint="48 KB per second of speech whatever the text. A reply past this limit is "
            "refused, never cut short.",
    saved="Speech limits saved"),
 "cs": dict(
    limits="Dlouhou odpověď přečte po dílcích a spojí je do jednoho souboru, takže "
           "server drží jen dílek, ne celou odpověď.",
    chunk="Znaků na dílek",
    chunk_hint="0 nechá celou odpověď v jednom zavolání. Každý další dílek stojí "
               "přibližně sekundu přípravy.",
    mb="Nejdelší odpověď (MB zvuku)",
    mb_hint="48 KB za sekundu řeči, bez ohledu na text. Odpověď nad tento limit se "
            "odmítne, nikdy se nezkrátí.",
    saved="Limity řeči uloženy"),
 "es": dict(
    limits="Una respuesta larga se lee en fragmentos y se une de nuevo en un solo "
           "archivo, así el servidor guarda un fragmento, no toda la respuesta.",
    chunk="Caracteres por fragmento",
    chunk_hint="0 mantiene toda la respuesta en una sola llamada. Cada fragmento extra "
               "cuesta cerca de un segundo de preparación.",
    mb="Respuesta más larga (MB de audio)",
    mb_hint="48 KB por segundo de voz sea cual sea el texto. Una respuesta que pase este "
            "límite se rechaza, nunca se recorta.",
    saved="Límites de voz guardados"),
 "fr": dict(
    limits="Une réponse longue est lue par morceaux puis recollée dans un seul fichier : "
           "le serveur garde un morceau, pas toute la réponse.",
    chunk="Caractères par morceau",
    chunk_hint="0 garde toute la réponse en un seul appel. Chaque morceau supplémentaire "
               "coûte environ une seconde de préparation.",
    mb="Réponse maximale (MB d'audio)",
    mb_hint="48 KB par seconde de voix, quel que soit le texte. Une réponse au-delà de "
            "cette limite est refusée, jamais coupée.",
    saved="Limites de voix enregistrées"),
 "ja": dict(
    limits="長い返文は分割して読み、1つのファイルにまとめ直します。サーバーは全体ではなく"
           "一部だけ保持します。",
    chunk="分割1回あたりの文字数",
    chunk_hint="0なら返文全体を1回の呼び出しで処理します。分割が1増えるごとに準備へ約1秒"
               "かかります。",
    mb="読み上げる返文の上限(音声MB)",
    mb_hint="音声はテキストに関係なく毎秒48 KBです。この上限を超えた返文は拒否され、"
            "切り詰められることはありません。",
    saved="音声の上限を保存しました"),
 "ko": dict(
    limits="긴 답변은 여러 조각으로 낭독한 뒤 하나의 파일로 합칩니다. 서버는 답변 전체가 "
           "아니라 한 조각만 보유합니다.",
    chunk="조각당 문자 수",
    chunk_hint="0이면 답변 전체를 한 번의 호출로 처리합니다. 조각이 하나 늘 때마다 준비에 "
               "약 1초가 듭니다.",
    mb="최대 답변 길이 (오디오 MB)",
    mb_hint="음성은 텍스트와 무관하게 초당 48 KB입니다. 이 한계를 넘는 답변은 거부되며, "
            "잘라내지 않습니다.",
    saved="음성 한계 저장됨"),
 "pt-BR": dict(
    limits="Uma resposta longa é lida em pedaços e junta de novo num único arquivo, "
           "então o servidor guarda um pedaço, não a resposta inteira.",
    chunk="Caracteres por pedaço",
    chunk_hint="0 mantém a resposta inteira numa só chamada. Cada pedaço extra custa "
               "cerca de um segundo de preparação.",
    mb="Maior resposta (MB de áudio)",
    mb_hint="48 KB por segundo de fala, qualquer que seja o texto. Uma resposta acima "
            "desse limite é recusada, nunca cortada.",
    saved="Limites de fala salvos"),
 "ru": dict(
    limits="Длинный ответ озвучивается частями и склеивается в один файл, поэтому "
           "сервер держит в памяти часть, а не весь ответ.",
    chunk="Знаков на часть",
    chunk_hint="0 оставляет весь ответ в одном вызове. Каждая дополнительная часть стоит "
               "около секунды на подготовку.",
    mb="Самый длинный ответ (МБ аудио)",
    mb_hint="48 КБ в секунду речи при любом тексте. Ответ сверх этого лимита отклоняется, "
            "но никогда не урезается.",
    saved="Лимиты речи сохранены"),
 "zh-TW": dict(
    limits="長回覆會分段朗讀再串接成單一檔案，因此伺服器只保留一段，而不是整個回覆。",
    chunk="每段字元數",
    chunk_hint="0 表示整個回覆只用一次呼叫。每多一段，準備時間約多一秒。",
    mb="可朗讀的最大回覆（音訊 MB）",
    mb_hint="不論文字，語音每秒 48 KB。超過此上限的回覆會被拒絕，絕不會被截短。",
    saved="已儲存語音上限"),
 "zh": dict(
    limits="长回复会分段朗读再拼接成单个文件，因此服务器只保留一段，而不是整个回复。",
    chunk="每段字符数",
    chunk_hint="0 表示整个回复只用一次调用。每多一段，准备时间约多一秒。",
    mb="可朗读的最大回复（音频 MB）",
    mb_hint="无论文字内容，语音每秒 48 KB。超过此上限的回复会被拒绝，绝不会被截短。",
    saved="已保存语音上限"),
}
NEW = [("uplift.voices.say_limits_hint", "limits"),
       ("uplift.voices.say_chunk_label", "chunk"),
       ("uplift.voices.say_chunk_hint", "chunk_hint"),
       ("uplift.voices.say_mb_label", "mb"),
       ("uplift.voices.say_mb_hint", "mb_hint"),
       ("uplift.voices.say_limits_saved", "saved")]
ANCHOR = '"uplift.voices.say_hint"'
root = pathlib.Path(__file__).resolve().parents[1] / "omlx_uplift" / "locales"

for lang, vals in T.items():
    path = root / f"{lang}.json"
    lines = path.read_text(encoding="utf-8").split("\n")
    hit = [l for l in lines if l.strip().startswith(ANCHOR)]
    assert len(hit) == 1, f"{lang}: anchor seen {len(hit)}x"
    assert hit[0].rstrip().endswith(","), f"{lang}: anchor lacks a comma"
    indent = hit[0][: len(hit[0]) - len(hit[0].lstrip())]
    out, added = [], 0
    for line in lines:
        out.append(line)
        if line.strip().startswith(ANCHOR):
            for key, field in NEW:
                if f'"{key}"' in line:
                    continue
                out.append(f"{indent}{json.dumps(key)}: "
                           f"{json.dumps(vals[field], ensure_ascii=False)},")
                added += 1
    path.write_text("\n".join(out), encoding="utf-8")
    data = json.loads(path.read_text(encoding="utf-8"))
    missing = [k for k, _ in NEW if k not in data]
    assert not missing, f"{lang}: still missing {missing}"
    same = [k for k, f in NEW if lang != "en" and data[k] == T["en"][f]]
    print(f"  {lang}.json: +{added} keys, json valid"
          + (f"  IDENTICAL TO EN: {same}" if same else ""))
