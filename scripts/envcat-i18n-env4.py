#!/usr/bin/env python3
"""Add the ENV-4 uplift.envcat.* keys to all locale files (i18n batch).

Same merge shape as scripts/envcat-i18n-add.py: existing key order and
formatting are preserved, a key already present is never overwritten.
Regenerated from the proofread table; edit the table, not the locales.
Legend entries quote the live chip key, so their glosses stay short.
"""
import json
import pathlib

LOCALES = pathlib.Path(__file__).resolve().parents[1] / "omlx_uplift" / "locales"

EN = {'uplift.envcat.dead': 'NO EFFECT',
 'uplift.envcat.dead_hint': 'Not editable: no live oMLX code path reads this variable any '
                            'more, so any value set here would do nothing. Documented so '
                            'the name is not lost.',
 'uplift.envcat.secret': 'SECRET',
 'uplift.envcat.secret_hint': 'A credential or key. Uplift never edits it and masks its '
                              'value wherever it appears.',
 'uplift.envcat.set_hint': 'Currently set in the running oMLX process environment',
 'uplift.envcat.stored_hint': 'Stored by Uplift, not yet in the process environment — '
                              'apply it with the restart the badge above names',
 'uplift.envcat.effect_hint': 'When a new value actually takes effect: immediately (oMLX '
                              'reads it per request), on the next model load, or only '
                              'after the server restarts',
 'uplift.envcat.settable_hint': 'Editable here. Uplift stores the value and seeds it when '
                                'the dev server starts; an unknown or wrong value can '
                                'change engine behaviour, so it is labelled experimental.',
 'uplift.envcat.managed_hint': 'Not editable: vanilla oMLX owns this variable. It either '
                               'writes the value itself at runtime (a setting the '
                               'dashboard already exposes drives it), or the variable is '
                               'the environment fallback of an exposed setting — editing '
                               'it here would conflict with that owner. Shown for '
                               'reference only.',
 'uplift.envcat.border_hint': 'Left border: this variable currently has a value in the '
                              'running oMLX process',
 'uplift.envcat.legend_border': 'coloured left border = currently set in the running '
                                'server',
 'uplift.envcat.intro_readonly': 'Reference only: this is the vanilla oMLX service. Uplift '
                                 'stores and seeds these overrides on omlx-dev only, so no '
                                 'value here can take effect on this server.',
 'uplift.envcat.apply_hint': 'Apply this value now. Leave the field empty to reset: the '
                             'stored override is deleted and oMLX returns to its stock '
                             'default on the next restart.',
 'uplift.envcat.filt.all': 'All',
 'uplift.envcat.filt.settable': 'Editable',
 'uplift.envcat.filt.readonly': 'Reference only',
 'uplift.envcat.filt.set': 'Currently set',
 'uplift.envcat.legend_managed': 'vanilla oMLX owns this variable',
 'uplift.envcat.legend_editable': 'editable here',
 'uplift.envcat.legend_effect': 'when a value takes effect'}

T = {'cs': {'uplift.envcat.dead': 'BEZ ÚČINKU',
        'uplift.envcat.dead_hint': 'Nelze upravovat: žádná živá cesta kódu oMLX už tuto '
                                   'proměnnou nečte, takže jakákoliv zde nastavená hodnota '
                                   'by nic neudělala. Uvedeno, aby název nezmizel.',
        'uplift.envcat.secret': 'TAJNÉ',
        'uplift.envcat.secret_hint': 'Přihlašovací údaj nebo klíč. Uplift jej nikdy '
                                     'neupravuje a hodnotu kdekoli maskuje.',
        'uplift.envcat.set_hint': 'Právě nastaveno v prostředí běžícího procesu oMLX',
        'uplift.envcat.stored_hint': 'Uloženo v Upliftu, zatím není v prostředí procesu — '
                                     'aplikujte restartem, který uvádí odznak výše',
        'uplift.envcat.effect_hint': 'Kdy se nová hodnota skutečně projeví: okamžitě (oMLX '
                                     'ji čte při každém požadavku), při příštím načtení '
                                     'modelu, nebo až po restartu serveru',
        'uplift.envcat.settable_hint': 'Lze upravovat. Uplift hodnotu uloží a při startu '
                                       'dev serveru ji vloží do prostředí; neznámá nebo '
                                       'špatná hodnota může změnit chování enginu, proto '
                                       'je označena jako experimentální.',
        'uplift.envcat.managed_hint': 'Nelze upravovat: tuto proměnnou vlastní původní '
                                      'oMLX. Buď ji za běhu sám zapisuje (řídí ji '
                                      'nastavení, které dashboard už ukazuje), nebo je '
                                      'environmentální variantou již zveřejněného '
                                      'nastavení — úprava zde by byla v konfliktu s tímto '
                                      'vlastníkem. Zobrazeno jen pro informaci.',
        'uplift.envcat.border_hint': 'Levý rámeček: tato proměnná má v běžícím procesu '
                                     'oMLX právě nějakou hodnotu',
        'uplift.envcat.legend_border': 'barevný levý rámeček = v běžícím serveru právě '
                                       'nastaveno',
        'uplift.envcat.intro_readonly': 'Jen pro informaci: toto je původní služba oMLX. '
                                        'Uplift tato nastavení ukládá a vloží je do '
                                        'prostředí jen na omlx-dev, takže zde nastavená '
                                        'hodnota se na tomto serveru nemůže projevit.',
        'uplift.envcat.apply_hint': 'Použít tuto hodnotu nyní. Pole nechte prázdné pro '
                                    'obnovení: uložená hodnota se smaže a oMLX se při '
                                    'příštím restartu vrátí ke výchozímu nastavení.',
        'uplift.envcat.filt.all': 'Vše',
        'uplift.envcat.filt.settable': 'Lze upravit',
        'uplift.envcat.filt.readonly': 'Jen pro informaci',
        'uplift.envcat.filt.set': 'Právě nastaveno',
        'uplift.envcat.legend_managed': 'tuto proměnnou vlastní původní oMLX',
        'uplift.envcat.legend_editable': 'lze upravit zde',
        'uplift.envcat.legend_effect': 'kdy se hodnota projeví'},
 'es': {'uplift.envcat.dead': 'SIN EFECTO',
        'uplift.envcat.dead_hint': 'No editable: ninguna ruta viva de oMLX lee ya esta '
                                   'variable, así que cualquier valor que se fije aquí no '
                                   'haría nada. Se documenta para no perder el nombre.',
        'uplift.envcat.secret': 'SECRETO',
        'uplift.envcat.secret_hint': 'Una credencial o clave. Uplift nunca la edita y '
                                     'oculta su valor dondequiera que aparezca.',
        'uplift.envcat.set_hint': 'Establecida actualmente en el entorno del proceso oMLX '
                                  'en ejecución',
        'uplift.envcat.stored_hint': 'Guardada por Uplift, aún no en el entorno del '
                                     'proceso — aplíquela con el reinicio que indica la '
                                     'etiqueta de arriba',
        'uplift.envcat.effect_hint': 'Cuándo surte efecto un valor nuevo: de inmediato '
                                     '(oMLX la lee por petición), en la siguiente carga de '
                                     'modelo, o solo tras reiniciar el servidor',
        'uplift.envcat.settable_hint': 'Editable aquí. Uplift guarda el valor y lo inyecta '
                                       'al iniciar el servidor de desarrollo; un valor '
                                       'desconocido o incorrecto puede cambiar el '
                                       'comportamiento del motor, por eso se marca como '
                                       'experimental.',
        'uplift.envcat.managed_hint': 'No editable: oMLX original es dueño de esta '
                                      'variable. O bien la escribe él mismo en tiempo de '
                                      'ejecución (la controla un ajuste que el panel ya '
                                      'expone), o la variable es la alternativa de entorno '
                                      'de un ajuste ya expuesto: editarla aquí entraría en '
                                      'conflicto con ese dueño. Solo por referencia.',
        'uplift.envcat.border_hint': 'Borde izquierdo: esta variable tiene actualmente un '
                                     'valor en el proceso oMLX en ejecución',
        'uplift.envcat.legend_border': 'borde izquierdo de color = actualmente establecido '
                                       'en el servidor',
        'uplift.envcat.intro_readonly': 'Solo referencia: este es el servicio oMLX '
                                        'original. Uplift guarda e inyecta estos valores '
                                        'solo en omlx-dev, así que ningún valor de aquí '
                                        'puede surtir efecto en este servidor.',
        'uplift.envcat.apply_hint': 'Aplicar este valor ahora. Deje el campo vacío para '
                                    'restablecer: se borra el valor guardado y oMLX vuelve '
                                    'a su valor predeterminado en el siguiente reinicio.',
        'uplift.envcat.filt.all': 'Todas',
        'uplift.envcat.filt.settable': 'Editables',
        'uplift.envcat.filt.readonly': 'Solo referencia',
        'uplift.envcat.filt.set': 'Establecidas',
        'uplift.envcat.legend_managed': 'oMLX original es dueño de esta variable',
        'uplift.envcat.legend_editable': 'editable aquí',
        'uplift.envcat.legend_effect': 'cuando se aplica el valor'},
 'fr': {'uplift.envcat.dead': 'SANS EFFET',
        'uplift.envcat.dead_hint': 'Non modifiable : aucun chemin de code oMLX actif ne '
                                   'lit plus cette variable, toute valeur définie ici '
                                   "n'aurait aucun effet. Documentée pour ne pas perdre le "
                                   'nom.',
        'uplift.envcat.secret': 'SECRET',
        'uplift.envcat.secret_hint': 'Un identifiant ou une clé. Uplift ne la modifie '
                                     'jamais et masque sa valeur partout.',
        'uplift.envcat.set_hint': "Actuellement définie dans l'environnement du processus "
                                  'oMLX en cours',
        'uplift.envcat.stored_hint': 'Enregistrée par Uplift, pas encore dans '
                                     "l'environnement du processus — appliquez-la par le "
                                     'redémarrage indiqué par le badge ci-dessus',
        'uplift.envcat.effect_hint': 'Quand une nouvelle valeur prend effet : '
                                     'immédiatement (oMLX la lit par requête), au prochain '
                                     'chargement de modèle, ou seulement après un '
                                     'redémarrage du serveur',
        'uplift.envcat.settable_hint': 'Modifiable ici. Uplift enregistre la valeur et '
                                       "l'injecte au démarrage du serveur de développement "
                                       '; une valeur inconnue ou fausse peut changer le '
                                       "comportement du moteur, d'où l'étiquette "
                                       'expérimental.',
        'uplift.envcat.managed_hint': "Non modifiable : oMLX d'origine possède cette "
                                      "variable. Soit il l'écrit lui-même à l'exécution "
                                      '(un réglage déjà exposé par le tableau de bord la '
                                      'pilote), soit la variable est le repli '
                                      "d'environnement d'un réglage déjà exposé — la "
                                      'modifier ici entrerait en conflit. Affichée à titre '
                                      'de référence.',
        'uplift.envcat.border_hint': 'Bordure gauche : cette variable a actuellement une '
                                     'valeur dans le processus oMLX en cours',
        'uplift.envcat.legend_border': 'bordure gauche colorée = actuellement définie sur '
                                       'le serveur',
        'uplift.envcat.intro_readonly': 'Référence seulement : ceci est le service oMLX '
                                        "d'origine. Uplift n'enregistre et n'injecte ces "
                                        'valeurs que sur omlx-dev ; aucune valeur ici ne '
                                        "peut s'appliquer à ce serveur.",
        'uplift.envcat.apply_hint': 'Appliquer cette valeur maintenant. Laissez le champ '
                                    'vide pour réinitialiser : la valeur enregistrée est '
                                    'supprimée et oMLX revient à sa valeur par défaut au '
                                    'prochain redémarrage.',
        'uplift.envcat.filt.all': 'Toutes',
        'uplift.envcat.filt.settable': 'Modifiables',
        'uplift.envcat.filt.readonly': 'Référence seule',
        'uplift.envcat.filt.set': 'Définies',
        'uplift.envcat.legend_managed': "oMLX d'origine possède cette variable",
        'uplift.envcat.legend_editable': 'modifiable ici',
        'uplift.envcat.legend_effect': "quand la valeur s'applique"},
 'ja': {'uplift.envcat.dead': '効果なし',
        'uplift.envcat.dead_hint': '変更不可：この変数を読む oMLX '
                                   'の実行経路はもう存在しないため、ここで値を設定しても何も起きません。名前は失わないよう記載しています。',
        'uplift.envcat.secret': '秘密',
        'uplift.envcat.secret_hint': '認証情報または鍵です。Uplift はこれを変更せず、値は表示される箇所で常に伏せます。',
        'uplift.envcat.set_hint': '実行中の oMLX プロセスの環境で現在設定されています',
        'uplift.envcat.stored_hint': 'Uplift に保存済みですがプロセス環境には未反映です。上のバッジが示す再起動で反映されます',
        'uplift.envcat.effect_hint': '新しい値が実際に有効になる時点：即時（oMLX '
                                     'がリクエストごとに読む）、次回モデル読み込み時、またはサーバー再起動後',
        'uplift.envcat.settable_hint': 'ここで変更できます。Uplift '
                                       'は値を保存し、開発サーバー起動時に環境へ設定します。未知・誤った値はエンジンの挙動を変える可能性があるため実験的と表示しています。',
        'uplift.envcat.managed_hint': '変更不可：この変数は oMLX '
                                      '本体が所有しています。実行中に本体自身が書き込む（既に公開済みの設定が駆動する）か、公開済みの設定の環境変数フォールバックのどちらかであり、ここで変更すると所有者と衝突します。参考表示のみです。',
        'uplift.envcat.border_hint': '左の枠線：この変数は実行中の oMLX プロセスで現在値を持っています',
        'uplift.envcat.legend_border': '左に色付きの枠線 = 実行中のサーバーで現在設定されています',
        'uplift.envcat.intro_readonly': '参考情報のみ：これは oMLX 本体のサービスです。Uplift はこれらのオーバーライドを '
                                        'omlx-dev でのみ保存・設定するため、ここでの変数はこのサーバーには有効になりません。',
        'uplift.envcat.apply_hint': 'この値を今適用します。フィールドを空にするとリセットされます。保存値を削除し、次回再起動時に oMLX '
                                    'の既定値へ戻ります。',
        'uplift.envcat.filt.all': 'すべて',
        'uplift.envcat.filt.settable': '変更可能',
        'uplift.envcat.filt.readonly': '参考のみ',
        'uplift.envcat.filt.set': '設定済み',
        'uplift.envcat.legend_managed': 'この変数は oMLX 本体が所有します',
        'uplift.envcat.legend_editable': 'ここで変更できます',
        'uplift.envcat.legend_effect': '値が有効になる時期'},
 'ko': {'uplift.envcat.dead': '효과 없음',
        'uplift.envcat.dead_hint': '수정 불가: 이 변수를 읽는 oMLX 실행 경로가 더 이상 없으므로 여기서 값을 지정해도 아무 '
                                   '일이 일어나지 않습니다. 이름은 기록용으로 두었습니다.',
        'uplift.envcat.secret': '비밀',
        'uplift.envcat.secret_hint': '자격 증명 또는 키입니다. Uplift는 이를 수정하지 않으며 값이 보이는 모든 곳에서 '
                                     '마스킹합니다.',
        'uplift.envcat.set_hint': '실행 중인 oMLX 프로세스 환경에 현재 설정되어 있습니다',
        'uplift.envcat.stored_hint': 'Uplift에 저장되었지만 프로세스 환경에는 아직 없습니다. 위 배지가 알려주는 재시작으로 '
                                     '적용됩니다',
        'uplift.envcat.effect_hint': '새 값이 실제로 적용되는 시점: 즉시(oMLX가 요청마다 읽음), 다음 모델 로드 시, 또는 '
                                     '서버 재시작 후',
        'uplift.envcat.settable_hint': '여기서 수정 가능합니다. Uplift는 값을 저장하고 개발 서버 시작 시 환경에 심습니다. '
                                       '알 수 없거나 잘못된 값은 엔진 동작을 바꿀 수 있어 실험적으로 표시합니다.',
        'uplift.envcat.managed_hint': '수정 불가: 이 변수는 기본 oMLX가 소유합니다. 실행 중 oMLX 스스로 값을 '
                                      '쓰거나(대시보드가 이미 노출한 설정이 제어) 노출된 설정의 환경 폴백이므로, 여기서 수정하면 '
                                      '소유자와 충돌합니다. 참고용으로만 표시됩니다.',
        'uplift.envcat.border_hint': '왼쪽 테두리: 이 변수는 실행 중인 oMLX 프로세스에 현재 값이 있습니다',
        'uplift.envcat.legend_border': '색이 있는 왼쪽 테두리 = 실행 중인 서버에 현재 설정됨',
        'uplift.envcat.intro_readonly': '참고 전용: 이것은 기본 oMLX 서비스입니다. Uplift는 이런 재정의값을 '
                                        'omlx-dev에서만 저장하고 심으므로, 여기서의 값은 이 서버에 적용될 수 없습니다.',
        'uplift.envcat.apply_hint': '이 값을 지금 적용합니다. 필드를 비우면 초기화됩니다. 저장된 재정의값을 삭제하고 다음 재시작 '
                                    '시 oMLX 기본값으로 돌아갑니다.',
        'uplift.envcat.filt.all': '전체',
        'uplift.envcat.filt.settable': '수정 가능',
        'uplift.envcat.filt.readonly': '참고 전용',
        'uplift.envcat.filt.set': '현재 설정됨',
        'uplift.envcat.legend_managed': '이 변수는 기본 oMLX가 소유합니다',
        'uplift.envcat.legend_editable': '여기서 수정 가능',
        'uplift.envcat.legend_effect': '값이 적용되는 시점'},
 'pt-BR': {'uplift.envcat.dead': 'SEM EFEITO',
           'uplift.envcat.dead_hint': 'Não editável: nenhum caminho ativo do oMLX lê esta '
                                      'variável, então qualquer valor definido aqui não '
                                      'faria nada. Documentada para não perder o nome.',
           'uplift.envcat.secret': 'SEGREDO',
           'uplift.envcat.secret_hint': 'Uma credencial ou chave. O Uplift nunca a edita e '
                                        'oculta seu valor onde quer que apareça.',
           'uplift.envcat.set_hint': 'Atualmente definida no ambiente do processo oMLX em '
                                     'execução',
           'uplift.envcat.stored_hint': 'Salva pelo Uplift, ainda não no ambiente do '
                                        'processo — aplique-a com o reinício que o selo '
                                        'acima indica',
           'uplift.envcat.effect_hint': 'Quando um valor novo entra em vigor: '
                                        'imediatamente (o oMLX a lê por requisição), no '
                                        'próximo carregamento de modelo, ou só após '
                                        'reiniciar o servidor',
           'uplift.envcat.settable_hint': 'Editável aqui. O Uplift guarda o valor e o '
                                          'injeta ao iniciar o servidor de '
                                          'desenvolvimento; um valor desconhecido ou '
                                          'errado pode mudar o comportamento do motor, por '
                                          'isso é marcado como experimental.',
           'uplift.envcat.managed_hint': 'Não editável: o oMLX original é dono desta '
                                         'variável. Ou ele mesmo a escreve em tempo de '
                                         'execução (uma configuração que o painel já expõe '
                                         'a controla), ou a variável é o equivalente de '
                                         'ambiente de uma configuração já exposta — '
                                         'editá-la aqui entraria em conflito com esse '
                                         'dono. Apenas referência.',
           'uplift.envcat.border_hint': 'Borda esquerda: esta variável tem atualmente um '
                                        'valor no processo oMLX em execução',
           'uplift.envcat.legend_border': 'borda esquerda colorida = atualmente definida '
                                          'no servidor',
           'uplift.envcat.intro_readonly': 'Somente referência: este é o serviço oMLX '
                                           'original. O Uplift guarda e injeta essas '
                                           'substituições apenas no omlx-dev, então nenhum '
                                           'valor aqui pode ter efeito neste servidor.',
           'uplift.envcat.apply_hint': 'Aplicar este valor agora. Deixe o campo vazio para '
                                       'redefinir: a substituição salva é apagada e o oMLX '
                                       'volta ao valor padrão no próximo reinício.',
           'uplift.envcat.filt.all': 'Todas',
           'uplift.envcat.filt.settable': 'Editáveis',
           'uplift.envcat.filt.readonly': 'Só referência',
           'uplift.envcat.filt.set': 'Definidas',
           'uplift.envcat.legend_managed': 'o oMLX original é dono desta variável',
           'uplift.envcat.legend_editable': 'editável aqui',
           'uplift.envcat.legend_effect': 'quando o valor entra em vigor'},
 'ru': {'uplift.envcat.dead': 'БЕЗ ЭФФЕКТА',
        'uplift.envcat.dead_hint': 'Не редактируется: ни один рабочий путь кода oMLX '
                                   'больше не читает эту переменную, поэтому любое '
                                   'значение здесь ни на что не повлияет. Указана, чтобы '
                                   'не потерять имя.',
        'uplift.envcat.secret': 'СЕКРЕТ',
        'uplift.envcat.secret_hint': 'Учётные данные или ключ. Uplift их не редактирует и '
                                     'везде скрывает значение.',
        'uplift.envcat.set_hint': 'Сейчас задано в окружении запущенного процесса oMLX',
        'uplift.envcat.stored_hint': 'Сохранено Uplift, но ещё не в окружении процесса — '
                                     'применится перезапуском, указанным значком выше',
        'uplift.envcat.effect_hint': 'Когда новое значение действительно применится: сразу '
                                     '(oMLX читает его на каждый запрос), при следующей '
                                     'загрузке модели или только после перезапуска сервера',
        'uplift.envcat.settable_hint': 'Можно редактировать здесь. Uplift сохраняет '
                                       'значение и подставляет его в окружение при запуске '
                                       'dev-сервера; неизвестное или неверное значение '
                                       'может изменить поведение движка, поэтому оно '
                                       'помечено как экспериментальное.',
        'uplift.envcat.managed_hint': 'Не редактируется: этой переменной владеет сам oMLX. '
                                      'Либо он записывает её во время работы (ею управляет '
                                      'настройка, уже доступная в панели), либо это '
                                      'окружение-дубль уже доступной настройки — правка '
                                      'здесь вступила бы в конфликт с этим владельцем. '
                                      'Только для справки.',
        'uplift.envcat.border_hint': 'Левая рамка: у этой переменной сейчас есть значение '
                                     'в запущенном процессе oMLX',
        'uplift.envcat.legend_border': 'цветная левая рамка = сейчас задано в работающем '
                                       'сервере',
        'uplift.envcat.intro_readonly': 'Только справка: это обычный сервис oMLX. Uplift '
                                        'сохраняет и подставляет эти значения лишь на '
                                        'omlx-dev, поэтому здесь они не могут действовать.',
        'uplift.envcat.apply_hint': 'Применить это значение сейчас. Оставьте поле пустым '
                                    'для сброса: сохранённое значение удаляется, и oMLX '
                                    'вернётся к заводскому при следующем перезапуске.',
        'uplift.envcat.filt.all': 'Все',
        'uplift.envcat.filt.settable': 'Редактируемые',
        'uplift.envcat.filt.readonly': 'Только справка',
        'uplift.envcat.filt.set': 'Заданные',
        'uplift.envcat.legend_managed': 'этой переменной владеет сам oMLX',
        'uplift.envcat.legend_editable': 'можно редактировать здесь',
        'uplift.envcat.legend_effect': 'когда значение подействует'},
 'zh': {'uplift.envcat.dead': '无作用',
        'uplift.envcat.dead_hint': '不可编辑：oMLX 中已无任何运行代码读取此变量，在此设置任何值都不会生效。保留记录以免名称丢失。',
        'uplift.envcat.secret': '机密',
        'uplift.envcat.secret_hint': '凭据或密钥。Uplift 从不编辑它，并在任何显示处遮盖其值。',
        'uplift.envcat.set_hint': '当前已设置在正在运行的 oMLX 进程环境中',
        'uplift.envcat.stored_hint': '已由 Uplift 保存，但尚未进入进程环境——请按上方徽标所指的重启使其生效',
        'uplift.envcat.effect_hint': '新值实际生效的时机：立即（oMLX 每次请求读取）、下次加载模型时，或仅在重启服务器后',
        'uplift.envcat.settable_hint': '可在此编辑。Uplift '
                                       '保存该值并在开发服务器启动时注入环境；未知或错误的值可能改变引擎行为，因此标记为实验性。',
        'uplift.envcat.managed_hint': '不可编辑：此变量由原版 oMLX 拥有。它要么在运行时由 oMLX '
                                      '自行写入（由面板已公开的设置驱动），要么是已公开设置的环境回退值——在此编辑会与该所有者冲突。仅供查阅。',
        'uplift.envcat.border_hint': '左边框：此变量在正在运行的 oMLX 进程中当前设有值',
        'uplift.envcat.legend_border': '带颜色的左边框 = 在运行中的服务器上当前已设置',
        'uplift.envcat.intro_readonly': '仅供参考：这是原版 oMLX 服务。Uplift 仅在 omlx-dev '
                                        '上保存并注入这些覆盖值，因此此处的值无法在本服务器生效。',
        'uplift.envcat.apply_hint': '立即应用此值。留空表示重置：将删除已保存的覆盖值，下次重启时 oMLX 恢复默认值。',
        'uplift.envcat.filt.all': '全部',
        'uplift.envcat.filt.settable': '可编辑',
        'uplift.envcat.filt.readonly': '仅查阅',
        'uplift.envcat.filt.set': '已设置',
        'uplift.envcat.legend_managed': '此变量由原版 oMLX 拥有',
        'uplift.envcat.legend_editable': '可在此编辑',
        'uplift.envcat.legend_effect': '值生效的时机'},
 'zh-TW': {'uplift.envcat.dead': '無作用',
           'uplift.envcat.dead_hint': '不可編輯：oMLX 中已無任何執行路徑讀取此變數，在此設定任何值都不會生效。保留記錄以免名稱遺失。',
           'uplift.envcat.secret': '機密',
           'uplift.envcat.secret_hint': '憑證或金鑰。Uplift 從不編輯它，並在任何顯示處遮蓋其值。',
           'uplift.envcat.set_hint': '目前已設定在正在執行的 oMLX 程序環境中',
           'uplift.envcat.stored_hint': '已由 Uplift 儲存，但尚未進入程序環境——請依上方徽章所指的重啟使其生效',
           'uplift.envcat.effect_hint': '新值實際生效的時機：立即（oMLX 每次請求讀取）、下次載入模型時，或僅在重啟伺服器後',
           'uplift.envcat.settable_hint': '可在此編輯。Uplift '
                                          '儲存該值並在開發伺服器啟動時注入環境；未知或錯誤的值可能改變引擎行為，因此標記為實驗性。',
           'uplift.envcat.managed_hint': '不可編輯：此變數由原版 oMLX 擁有。它由 oMLX '
                                         '在執行時自行寫入（由面板已公開的設定驅動），或是已公開設定的環境回退值——在此編輯會與該所有者衝突。僅供查閱。',
           'uplift.envcat.border_hint': '左邊框：此變數在正在執行的 oMLX 程序中目前設有值',
           'uplift.envcat.legend_border': '帶顏色的左邊框 = 在執行中的伺服器上目前已設定',
           'uplift.envcat.intro_readonly': '僅供參考：這是原版 oMLX 服務。Uplift 僅在 omlx-dev '
                                           '上儲存並注入這些覆蓋值，因此此處的值無法在本伺服器生效。',
           'uplift.envcat.apply_hint': '立即套用此值。留空表示重設：將刪除已儲存的覆蓋值，下次重啟時 oMLX 恢復預設值。',
           'uplift.envcat.filt.all': '全部',
           'uplift.envcat.filt.settable': '可編輯',
           'uplift.envcat.filt.readonly': '僅查閱',
           'uplift.envcat.filt.set': '已設定',
           'uplift.envcat.legend_managed': '此變數由原版 oMLX 擁有',
           'uplift.envcat.legend_editable': '可在此編輯',
           'uplift.envcat.legend_effect': '值生效的時機'}}



def merge(path, adds):
    data = json.loads(path.read_text(encoding="utf-8"))
    before = len(data)
    added = []
    for k, v in adds.items():
        if k not in data:
            data[k] = v          # append; existing order and formatting kept
            added.append(k)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n",
                    encoding="utf-8")
    return before, len(data), added


for name in ["en", "cs", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-TW", "zh"]:
    adds = dict(EN)
    adds.update(T.get(name, {}))
    b, a, added = merge(LOCALES / f"{name}.json", adds)
    print(f"{name}: {b} -> {a} (+{len(added)})")
