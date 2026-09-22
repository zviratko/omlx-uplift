#!/usr/bin/env python3
"""One-shot: add uplift.inflight.* redesign keys to all locale files (sorted)."""
import json, pathlib

T = {
 "en":     dict(done="DONE", aborted="ABORTED", refused="REFUSED", error="ERROR",
                queued="QUEUED", abort="ABORT", expand="show queued requests",
                cached_prefix="cached prefix tokens (reused, not recomputed)"),
 "es":     dict(done="HECHA", aborted="INTERRUMPIDA", refused="RECHAZADA", error="ERROR",
                queued="EN COLA", abort="INTERRUMPIR", expand="mostrar solicitudes en cola",
                cached_prefix="tokens de prefijo en caché (reutilizados, no recalculados)"),
 "fr":     dict(done="TERMINÉE", aborted="ANNULÉE", refused="REFUSÉE", error="ERREUR",
                queued="EN ATTENTE", abort="ANNULER", expand="afficher les requêtes en attente",
                cached_prefix="jetons de préfixe en cache (réutilisés, non recalculés)"),
 "ja":     dict(done="完了", aborted="中止", refused="拒否", error="エラー",
                queued="キュー待ち", abort="中止", expand="キュー待ちのリクエストを表示",
                cached_prefix="キャッシュ済みプレフィックス（再利用、再計算なし）"),
 "ko":     dict(done="완료", aborted="중단됨", refused="거부됨", error="오류",
                queued="대기 중", abort="중단", expand="대기 중인 요청 보기",
                cached_prefix="캐시된 프리픽스(재사용, 재계산 없음)"),
 "pt-BR":  dict(done="CONCLUÍDA", aborted="INTERROMPIDA", refused="RECUSADA", error="ERRO",
                queued="NA FILA", abort="INTERROMPER", expand="mostrar requisições na fila",
                cached_prefix="tokens de prefixo em cache (reutilizados, não recalculados)"),
 "ru":     dict(done="ГОТОВО", aborted="ПРЕРВАНО", refused="ОТКЛОНЁН", error="ОШИБКА",
                queued="В ОЧЕРЕДИ", abort="ПРЕРВАТЬ", expand="показать запросы в очереди",
                cached_prefix="токсы префикса в кэше (переиспользуются, не пересчитываются)"),
 "zh-TW":  dict(done="完成", aborted="已中止", refused="已拒絕", error="錯誤",
                queued="排隊中", abort="中止", expand="顯示排隊中的請求",
                cached_prefix="已快取的前綴 token（重複使用，未重新計算）"),
 "zh":     dict(done="完成", aborted="已中止", refused="已拒绝", error="错误",
                queued="排队中", abort="中止", expand="显示排队中的请求",
                cached_prefix="已缓存的前缀 token（复用，未重新计算）"),
}

base = pathlib.Path(__file__).resolve().parents[1] / "omlx_uplift" / "locales"
for lang, vals in T.items():
    p = base / f"{lang}.json"
    lines = p.read_text(encoding="utf-8").rstrip("\n").split("\n")
    # insert as a block right after the last existing uplift.inflight.* line
    idx = max(i for i, ln in enumerate(lines) if '"uplift.inflight.' in ln)
    block = [f'  "uplift.inflight.{k}": {json.dumps(v, ensure_ascii=False)}'
             for k, v in vals.items()]
    # json.dumps needs a comma unless it lands last (it can't: } follows)
    out = lines[:idx + 1] + [ln + "," for ln in block] + lines[idx + 1:]
    p.write_text("\n".join(out) + "\n", encoding="utf-8")
    json.loads(p.read_text(encoding="utf-8"))   # must still parse
    print(f"{lang}: +{len(vals)} keys after line {idx + 1}")
