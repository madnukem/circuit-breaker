# Next Generation Circuit Breaker: Research Report

> Исследование архитектурных улучшений для перехода от детектора повторных команд к通用ному guardrail агентного reasoning'а.

Автор: Vassa | Дата: 2026-06-02

---

## Оглавление

1. [Progress Detection vs Retry Detection](#topic-1)
2. [Semantic Error Fingerprinting](#topic-2)
3. [Hypothesis Tracking](#topic-3)
4. [Structured Recovery Plans](#topic-4)
5. [Observability Debt](#topic-5)
6. [Cost-Aware Breaking](#topic-6)
7. [Hierarchical Breakers](#topic-7)
8. [Prior Art and Novelty Assessment](#topic-8)
9. [Architectural Recommendations](#recommendations)
10. [Ranked Implementation Roadmap](#roadmap)

---

<a id="topic-1"></a>
## 1. Progress Detection vs Retry Detection

### Проблема

Текущий breaker триггерится после N повторных failures. Но повторные failures не всегда означают стагнацию:

```
Попытка 1: 112 тестов падает
Попытка 2: 57 тестов падает
Попытка 3: 11 тестов падает
```

Агент делает прогресс, несмотря на failures. Breaker не должен срабатывать при продуктивной итерации.

### Подходы из literature

#### 1.1 Hill Climbing Plateau Detection

Классическая проблема в search algorithms — как отличить plateau (нет прогресса) от ridge (медленный, но реальный прогресс).

**Методы:**
- **Tabu Search** (Glover, 1989): запрещает возврат к недавно посещённым состояниям. Применение: breaker запоминает последние N failure fingerprints и триггерится только при повторе уже виденного fingerprint.
- **Simulated Annealing**: принимает worse solutions с вероятностью, уменьшающейся со временем. Для breaker: первые 2 failures — warning, 3-й — trip, но если между ними были success-ы (прогресс), threshold увеличивается.
- **Plateau detection via fitness trail**: если sequence из K последовательных states не показывает improvement — это plateau.

**Применение к breaker:** Хранить "fitness score" для каждой категории команд. Fitness = `(1 / failure_count) * recency_weight`. Если fitness не улучшается N итераций — plateau.

#### 1.2 Numerical Progress Extraction

Автоматическое извлечение числовых метрик из tool output:

```javascript
// Парсинг чисел из output для delta detection
const progressPatterns = [
  /(\d+)\s*(?:tests?|specs?|cases?)\s*(?:fail|pass)/i,
  /(\d+)\s*(?:errors?|warnings?|issues?)/i,
  /(\d+)%\s*(?:complete|coverage|progress)/i,
  /(\d+)\s*(?:files?|modules?|packages?)\s*(?:changed|fixed|remaining)/i,
];
```

**Алгоритм:**
1. При каждом failure — извлечь числовые метрики из output
2. Сравнить с предыдущими метриками
3. Если delta > threshold → прогресс есть, breaker не триггерить
4. Если delta ≈ 0 или ухудшение → считать как stagnation

**Сложность реализации:** ~80-120 LOC. Не требует ML, только regex extraction + простая delta logic.

**Риск false positives:** Высокий для output без числовых паттернов. Низкий для structured output (тест-раннеры, build systems).

#### 1.3 Agent Evaluation Frameworks

**rlbench, BabyAI, ALFWorld** — среды где progress измеряется task completion metrics.

Для breaker: не применимо напрямую (требует external environment), но принцип "task completion percentage" можно заимствовать через structured output parsing.

### Вывод по Topic 1

| Подход | Сложность | Польза | Риск |
|--------|-----------|--------|------|
| Numerical delta detection | ~100 LOC | Высокая для тестов/build | FP для не-числового output |
| Tabu Search fingerprint check | ~50 LOC | Средняя | Низкий |
| Fitness plateau detection | ~150 LOC | Средняя | FP при медленном прогрессе |

**Рекомендация:** Начать с numerical delta detection — наибольшее соотношение польза/сложность.

---

<a id="topic-2"></a>
## 2. Semantic Error Fingerprinting

### Проблема

Текущая реализация делает синтаксическую нормализацию (пути → `/...`, хеши → `<h>`, номера строк → `N`). Это группирует ошибки с разными путями, но **не понимает семантику**:

```
"Cannot find module 'lodash'"       → fingerprint A
"Module not found: ./utils"         → fingerprint B
"Package 'express' not installed"   → fingerprint C
"Error: Cannot resolve dependency"  → fingerprint D
```

Все четыре — одна корневая причина: **отсутствует зависимость**. Breaker не видит паттерна.

### Алгоритмы кластеризации логов

#### 2.1 Drain (He, Zhu, Zheng, Lyu — ICWS 2017)

Онлайн-алгоритм с деревом фиксированной глубины (parse tree). Группирует лог-сообщения по: длине → начальным токенам → token similarity (порог 0.3-0.5). F-measure 0.84-0.99 на тестовых данных. Сложность O(n).

**Пригодность:** Отличная для hook. Полностью детерминирован, ~300-400 LOC на JavaScript.

#### 2.2 Spell (Du, Li — ICDM 2016)

LCS-based (Longest Common Subsequence) онлайн-алгоритм. F-measure 0.82-0.99. Склонен к under-partitioning — "Receive from node 4" и "4 Receive from node" дадут одинаковый LCS.

**Пригодность:** Умеренная. LCS вычислительно тяжелее Drain. ~200-300 LOC.

#### 2.3 LenMa (Mizutani 2013)

Группировка по длине + евклидово расстояние между векторами токенов. Простой, но менее точный (F-measure 0.68-0.85). ~150-200 LOC.

#### 2.4 IPLoM (Makanju и др., 2009)

Офлайн-алгоритм с 3-шаговой иерархической партицией. **Не подходит для hook** — требует загрузки всех логов.

| Алгоритм | Тип | F-measure | LOC (JS) | Подходит? |
|----------|-----|-----------|----------|-----------|
| **Drain** | Онлайн | 0.84-0.99 | 300-400 | Да (лучший) |
| Spell | Онлайн | 0.82-0.99 | 200-300 | Умеренно |
| LenMa | Онлайн | 0.68-0.85 | 150-200 | Да (проще) |
| IPLoM | Офлайн | 0.65-0.99 | 400-500 | Нет |

### Подход Sentry к группировке

Sentry группирует ошибки через stack trace хеширование + fallback на message-based группировку с нормализацией чисел/UUID. Sentry **не делает семантической** группировки — "Cannot find module" и "Module not found" для Sentry — разные issues. Нам нужно пойти дальше.

### Практическое решение: Rule-based таксономия

**12 классов корневых причин:**

```
1.  DEPENDENCY_MISSING    — модуль/пакет не найден, не установлен
2.  DEPENDENCY_VERSION    — конфликт версий, несовместимость
3.  TYPE_ERROR            — несоответствие типов, null/undefined
4.  SYNTAX_ERROR          — синтаксические ошибки, неверные токены
5.  PERMISSION_DENIED     — доступ запрещен
6.  FILE_NOT_FOUND        — файл/директория не существует
7.  NETWORK_ERROR         — таймаут, connection refused, DNS
8.  BUILD_FAILED          — компиляция/сборка упала
9.  TEST_FAILED           — assertion failure
10. CONFIG_ERROR          — неверная конфигурация, missing env vars
11. RESOURCE_EXHAUSTED    — OOM, disk full
12. RUNTIME_CRASH         — segfault, abort, process killed
```

**Как это меняет fingerprint:**

```javascript
// Старый: failKey = "f:Bash:npm install:" + sha256(normalized_error)
// Новый:  failKey = "f:Bash:npm install:" + classifyError(output)

function classifyError(output) {
  for (const [cls, patterns] of Object.entries(ERROR_CLASSES)) {
    for (const re of patterns) {
      if (re.test(output)) return cls;
    }
  }
  return 'UNKNOWN';  // fallback на normalizeError()
}
```

**Покрытие:** Топ-5 классов (DEPENDENCY_MISSING, TYPE_ERROR, SYNTAX_ERROR, BUILD_FAILED, TEST_FAILED) покрывают **55-80% всех CI/build ошибок**. Все 12 классов — **85-95%**.

### Гибридный подход: Rule-based + normalizeError fallback

```
Уровень 1: classifyError() → семантический класс (80%+ ошибок)
Уровень 2: normalizeError() → текущий hash (для неизвестных ошибок)
```

### Вывод по Topic 2

| Подход | Сложность | Польза | Риск |
|--------|-----------|--------|------|
| Rule-based taxonomy (12 классов) | ~110 LOC (80-120 regex) | Высокая | Не покрывает экзотические ошибки |
| Drain-lite fallback | ~150 LOC | Средняя | Избыточен для нашей задачи |
| Полный Drain | ~350 LOC | Высокая | Over-engineering |

**Рекомендация:** Rule-based taxonomy из 12 классов + fallback на текущий `normalizeError()`. Это даёт breaker'у "понимание" корневых причин за ~110 LOC, без ML, за <1ms на ошибку.

---

<a id="topic-3"></a>
## 3. Hypothesis Tracking

### Проблема

Агент повторяет действия, не осознавая, что действует на основе одной и той же (возможно неверной) гипотезы:

```
H1: "Проблема в Dockerfile"  → docker build → FAIL
H1: "Проблема в Dockerfile"  → docker build --no-cache → FAIL
H1: "Проблема в Dockerfile"  → docker build --build-arg → FAIL
```

Три разные команды, три категории — breaker не срабатывает. Но гипотеза одна и та же.

### Research findings

#### BDI (Belief-Desire-Intention) Agent Architecture

Классическая модель агентных систем (Rao & Georgeff, 1995). BDI-агенты:
- **Beliefs** — знания о мире (текущее состояние системы)
- **Desires** — цели (fix the build)
- **Intentions** — выбранные планы действий (concrete commands)

Для breaker: если Intentions меняются, но underlying Desire/Belief — нет → агент топчется.

**Из [AAMAS 2024: Empowering BDI Agents with Generalised Decision-Making](https://www.ifaamas.org/Proceedings/aamas2024/pdfs/p2679.pdf):**
- Model-based Goal Recognition — определение цели агента по наблюдаемым действиям
- Применение: breaker может распознать, что агент преследует одну и ту же цель разными средствами

**Из [ECAI 2024: Practical Operational Semantics for Classical Planning in BDI](https://www.meneguzzi.eu/felipe/pubs/ecai-bdi-plan-2024.pdf):**
- CAN — high-level agent programming language для BDI
- Практическая семантика без усложнения

**Из [arXiv 2205.00979: Real-Time BDI Agents](https://arxiv.org/html/2205.00979v2):**
- Реорганизация control loop для real-time систем
- Timeout-механизмы для intentions — релевантно для breaker'а

#### Plan Recognition в AI

**Key insight:** Нам не нужен полный plan recognition — только определение "та же стратегия или новая".

### Практический подход: Command Intent Clustering

Вместо полноценного BDI, применяем lightweight эвристику:

**Уровень 1: Command Flag Grouping**

Многие "разные" команды — одна и та же гипотеза с разными флагами:

```javascript
const INTENT_GROUPS = {
  'docker build': {
    commands: ['docker build'],
    flags: ['--no-cache', '--build-arg', '--target', '--platform', '-t'],
    message: 'Same build strategy with different flags'
  },
  'npm install': {
    commands: ['npm install', 'npm i', 'yarn install', 'pnpm install'],
    flags: ['--force', '--legacy-peer-deps', '--save-dev', '-g'],
    message: 'Same dependency resolution strategy'
  },
  'mvn compile': {
    commands: ['mvn compile', 'mvn clean compile', 'mvn install', 'mvn package'],
    flags: ['-DskipTests', '-P', '-pl', '--also-make'],
    message: 'Same build strategy'
  }
};
```

**Уровень 2: Output Similarity как proxy для гипотезы**

Если 3 разных команды в одном domain дают ошибки одного класса → агент действует по одной гипотезе:

```javascript
function detectStaleHypothesis(state, domain, semanticClass, now) {
  const recentFails = getRecentFailures(domain, now, 15 * 60 * 1000); // 15 min
  const sameClassCount = recentFails.filter(f => f.cls === semanticClass).length;
  return sameClassCount >= 3;
}
```

### Сложность и компромиссы

| Подход | Сложность | Польза | Риск |
|--------|-----------|--------|------|
| Intent group mapping | ~80 LOC | Средняя | Hardcoded группы |
| Domain + semantic class tracking | ~60 LOC (поверх Topic 2 и 7) | Высокая | Зависит от Topics 2, 7 |
| Full BDI integration | 1000+ LOC | Очень высокая | Academic overkill |

### Вывод по Topic 3

**Рекомендация:** Domain + semantic class tracking — если Topics 2 (semantic fingerprinting) и 7 (hierarchical breakers) реализованы, hypothesis tracking "бесплатно" получается как комбинация: `domain + error_class` за 3 попытки → stale hypothesis warning. Дополнительных ~60 LOC поверх уже реализованных Topics 2 и 7.

---

<a id="topic-4"></a>
## 4. Structured Recovery Plans

### Проблема

Текущий recovery plan — free-form текст. Breaker не может определить, изменил ли агент стратегию.

### Анализ incident response practices

#### Google SRE Post-Mortem Template

Структура из [Google SRE Workbook](https://sre.google/workbook/postmortem-culture/):
- **Incident Timeline** — что произошло, когда
- **Root Cause** — почему
- **Impact** — кто/что затронуто
- **Lessons Learned** — что поняли
- **Action Items** — что делать

#### Atlassian Incident Response

Из [Atlassian Post-Mortem Templates](https://www.atlassian.com/incident-management/postmortem/templates):
- Summary
- Timeline
- Root Cause Analysis (5 Whys)
- Corrective Actions

#### Применение к breaker

**Минимальная структура для recovery plan:**

```json
{
  "hypothesis": "Проблема в dependency resolution",
  "evidence": "npm install даёт ERESOLVE ошибку",
  "alternative": "Попробую удалить node_modules и lockfile",
  "verification": "Запущу npm install заново и проверю lockfile"
}
```

### Как валидировать strategy change

**Проблема:** Агент может написать план, но не изменить поведение.

**Решение — structural diff:**

1. При OPEN breaker — сохранить текущий recovery plan
2. При probe — сравнить новый plan с предыдущим
3. Probe допускается только если plan materially отличается

**Metric для "materially differs":**
- `hypothesis` изменился → OK
- `alternative` изменился → OK
- Только `verification` изменился → NOT OK (тот же подход, другая проверка)

**Сложность:** ~100-150 LOC для plan storage + diff logic.

**Проблема:** Кто validate the plan? Если breaker валидирует сам — это circular logic. Нужен внешний валидатор (LLM call или rule-based).

### Вывод по Topic 4

| Подход | Сложность | Польза | Риск |
|--------|-----------|--------|------|
| Structured plan template | ~50 LOC | Средняя | Агент может заполнять формально |
| Plan diff validation | ~150 LOC | Высокая | Circular logic risk |
| Rule-based plan validator | ~200 LOC | Высокая | Хрупкость правил |

**Рекомендация:** Structured plan template как обязательный формат при recovery. Diff validation — v2. Без LLM calls.

---

<a id="topic-5"></a>
## 5. Observability Debt Detection

### Проблема

Большинство loops вызваны не неправильными действиями, а отсутствием visibility:

```
run e2e → OK → "не работает"
run e2e → OK → "не работает"
run e2e → OK → "не работает"
```

Нет: логов, скриншотов, traces, runtime state. Агент не имеет evidence.

### Research findings

**Ключевой insight из [AgentSight (arXiv 2508.02736)](https://arxiv.org/html/2508.02736v2):**
- "Boundary tracing" — monitor at stable system interfaces
- Агенты нуждаются в observability на уровне system calls, не только tool output

**Из [TrueFoundry: Agent Observability](https://www.truefoundry.com/blog/ai-agent-observability-tools):**
- 46% AI agent POCs fail из-за observability gap
- Три столпа: traces, metrics, logs

**Из [Augment Code: Agent Tracing](https://www.augmentcode.com/guides/agent-observability-for-ai-coding):**
- Execution spans, output evaluations, cost attribution

### Как обнаружить observability gap в hook

**Признаки отсутствующей observability:**

1. Агент run-нул consequential command N раз без intermediate read commands
2. Агент не запрашивал логи, файлы, или env между попытками
3. Output содержит "pass" / "ok" / "success" но нет конкретных чисел
4. Между повторными run-ами нет Read/Glob/Grep команд

**Алгоритм:**

```javascript
function detectObservabilityGap(state, category, now) {
  const recentCmds = getRecentCommands(category, now, 10 * 60 * 1000); // last 10 min
  const runs = recentCmds.filter(c => c.type === 'run');
  const reads = recentCmds.filter(c => c.type === 'read');

  if (runs.length >= 3 && reads.length === 0) {
    return {
      gap: true,
      message: 'Agent reruns commands without gathering evidence between attempts',
      suggestion: 'Add logging, read output files, check runtime state before retrying'
    };
  }
  return { gap: false };
}
```

**Сложность:** ~80 LOC. Работает поверх существующего decision log.

**Риск FP:** Средний — иногда агент legitimately не нуждается в intermediate reads (простые fixes).

### Вывод по Topic 5

| Подход | Сложность | Польза | Риск |
|--------|-----------|--------|------|
| Read-between-runs detection | ~80 LOC | Высокая | FP для simple fixes |
| Output richness scoring | ~60 LOC | Средняя | Зависит от output формата |
| Combined observability score | ~150 LOC | Высокая | Настройка thresholds |

**Рекомендация:** Начать с read-between-runs detection — прямое обнаружение "blind retry". Лучшая польза на единицу сложности из всех 8 topics.

---

<a id="topic-6"></a>
## 6. Cost-Aware Breaking

### Проблема

Текущие thresholds — attempt-based. Все команды равны. Но `docker build` может стоить минуты, а `npm test` — секунды.

### Research findings

**Из [TrueFoundry: Rate Limiting AI Agents](https://www.truefoundry.com/blog/rate-limiting-ai-agents-preventing-llm-api-exhaustion):**
- "Cost-velocity breaker" — ловит slow runaways которые token bucket пропускает
- Конфигурация: 10× planned rate как default threshold

**Из [Galileo AI: Unbounded Consumption](https://galileo.ai/blog/prevent-llm-unbounded-consumption):**
- Cost-aware scaling — cap resource allocation при превышении thresholds
- Для LLM: token consumption + wall clock time

**Из [Zuplo: Token-Based Rate Limiting](https://zuplo.com/learning-center/token-based-rate-limiting-ai-agents):**
- Token-based limits делают cost anomalies видимыми
- Alerts для consumers с неожиданными spike'ами

### Метрики для cost-aware breaking

| Метрика | Доступность | Точность |
|---------|-------------|----------|
| Wall clock time | Легко (Date.now()) | Высокая |
| Command count | Уже есть | Высокая |
| Token consumption | Нужен access к API response | Низкая (hook не видит tokens) |
| API cost ($) | Нет доступа | Нет |
| Compute usage | Нет доступа | Нет |

### Практический подход

```javascript
// Cost model: cumulative time spent retrying a category
function shouldTripOnCost(state, category) {
  const entries = state[`cost:${category}`];
  if (!entries) return false;
  const totalTime = entries.reduce((sum, e) => sum + e.duration, 0);
  return totalTime > CFG.maxCumulativeTimeMs; // e.g., 10 minutes
}
```

**Проблема:** Hook не знает duration команды — он получает только PreToolUse/PostToolUse события. Можно вычислять delta между timestamp'ами.

**Реальное решение:** PreToolUse сохраняет timestamp → PostToolUse вычисляет delta → накапливает в state.

**Сложность:** ~120 LOC для tracking + cost model.

### Вывод по Topic 6

| Подход | Сложность | Польза | Риск |
|--------|-----------|--------|------|
| Wall-clock cumulative cost | ~120 LOC | Средняя | Нужен Pre→Post timestamp tracking |
| Time-weighted attempt counting | ~60 LOC | Средняя | Проще, но менее точно |
| Token-based cost | Невозможно в hook | Высокая | Hook не видит token usage |

**Рекомендация:** Time-weighted attempt counting — заменяет flat threshold на `sum(command_duration) > maxWasteMs`. Простая модификация текущего counting mechanism.

---

<a id="topic-7"></a>
## 7. Hierarchical Breakers

### Проблема

Текущий scope — command-category level (`docker build -t`). Но loops могут существовать на более высоких уровнях абстракции:

```
Level 1: docker build (конкретная команда)
Level 2: build-system troubleshooting (область)
Level 3: attempting to fix compilation problems (стратегия)
```

### Research findings

**Из [IJRAI: Circuit Breaker Pattern in Distributed Systems](https://www.ijrai.org/index.php/ijrai/article/view/433):**
- Adaptive circuit breakers — multi-level, context-aware failure management
- В микросервисах: per-instance → per-service → per-cluster → per-cell

**Из [Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker):**
- Failure domain design: каждый service boundary — потенциальный failure domain
- Иерархические breakers: trip на низком уровне не обязательно триггерит верхний

### Применение к LLM agent

**Двухуровневая иерархия:**

```
Level 2 (Domain):  "containerization"
  ├── Level 1 (Command):  "docker build -t app ."
  ├── Level 1 (Command):  "docker compose up"
  └── Level 1 (Command):  "docker run --rm app"

Level 2 (Domain):  "dependency-management"
  ├── Level 1 (Command):  "npm install"
  ├── Level 1 (Command):  "npm install --force"
  └── Level 1 (Command):  "npm install --legacy-peer-deps"
```

**Правила:**
- Level 1 breaker: 3 одинаковых commands → trip
- Level 2 breaker: 3+ Level 1 trips в одном domain → domain trip

### Сложность реализации

**Как определить "domain" без LLM:**

```javascript
const DOMAINS = {
  'docker': 'containerization',
  'npm': 'dependency-management',
  'mvn': 'build-system',
  'gradle': 'build-system',
  'kubectl': 'deployment',
  'python': 'runtime',
  'dotnet': 'build-system',
};

function getDomain(category) {
  const firstWord = category.split(' ')[0];
  return DOMAINS[firstWord] || 'general';
}
```

**Сложность:** ~200 LOC для двухуровневой иерархии (command + domain). Третий уровень (strategy) — ещё ~150 LOC + domain relationship mapping.

### Вывод по Topic 7

| Подход | Сложность | Польза | Риск |
|--------|-----------|--------|------|
| Command + Domain (2-level) | ~200 LOC | Высокая | Простая эвристика для domain |
| Full 3-level hierarchy | ~350 LOC | Очень высокая | Over-engineering risk |
| Dynamic domain detection | ~300 LOC + ML | Очень высокая | Не подходит для hook |

**Рекомендация:** Двухуровневая иерархия (command + domain). Третий уровень — наблюдать.

---

<a id="topic-8"></a>
## 8. Prior Art and Novelty Assessment

### Академические источники

#### Representation Engineering / Neural Circuit Breakers

**[Improving Alignment and Robustness with Circuit Breakers (NeurIPS 2024)](https://arxiv.org/html/2406.04313v4)** — Zou et al. Представляет circuit breakers как механизм модификации внутренних активаций модели для предотвращения harmful outputs. Это **безопасность на уровне модели**, не agent runtime. Наш подход — на уровне tool calls и observable behavior.

#### BDI Agent Architecture

Классическая модель (Rao & Georgeff, 1995). BDI описывает reasoning architecture агентов. Наш breaker — это external observer, не внутренний reasoning механизм. **Разные уровни абстракции.**

### Промышленные инструменты

#### Microsoft Agent Governance Toolkit (AGT)

**[github.com/microsoft/agent-governance-toolkit](https://github.com/microsoft/agent-governance-toolkit)** — релиз April 2026. Open-source middleware для runtime governance AI-агентов. Включает circuit breakers, SLOs, error budgets, Prometheus-метрики. Agent OS — governance kernel между агентами и их действиями, <1ms overhead.

**Ключевое отличие:** AGT работает как middleware в Python/TypeScript runtime. Наш breaker — как hook в Claude Code shell, без доступа к agent internals. AGT не делает fingerprinting или semantic grouping — только thresholds.

#### AgentCircuit

**[github.com/simranmultani197/AgentCircuit](https://github.com/simranmultani197/AgentCircuit)** — Python decorator для AI agent функций. Loop detection, auto-repair, output validation, budget control.

**Ключевое отличие:** AgentCircuit работает на уровне отдельных function calls. Наш breaker — на уровне shell commands с fingerprinting и state machine.

#### Devin / Cognition AI

Из [Cognition blog: "Don't Build Multi-Agents"](https://cognition.ai/blog/dont-build-multi-agents) — описывает dynamic agent systems и automatic recovery. Из [Devin Agents 101](https://devin.ai/agents101) — best practices для предотвращения stuck loops.

**Ключевое отличие:** Закрытая архитектура, internal reasoning. Наш подход — external observability.

### Патентный ландшафт

| Область | Prior Art | Дата |
|---------|-----------|------|
| Circuit breaker для микросервисов | Nygard, *Release It!* | 2007 |
| FSM-based multi-agent orchestration | MetaAgent (arXiv) | 2025 |
| RepE-based neural circuit breakers | Zou et al. (NeurIPS) | 2024 |
| Agent reasoning loop detection | AgentCircuit, Cordum blog | 2025-2026 |
| Behavioral circuit breakers | NeuralTrust, Syntaxia, Microsoft AGT | 2025-2026 |
| Multi-agent patents | US8095496B2, C3 AI patent | Various |

### Сводная таблица: Loop Detection в существующих системах

| Система | Loop Detection | State Machine | HALF-OPEN / Recovery | Reasoning-Level |
|---------|---------------|---------------|---------------------|-----------------|
| Reflexion (Shinn, 2023) | Soft (via memory) | Нет | Нет | Частично |
| ReAct (Yao, 2022) | Hard step limit | Нет | Нет | Нет |
| Self-Refine (Madaan, 2023) | Convergence check | Нет | Нет | Нет |
| Voyager (Wang, 2023) | Curriculum tracking | Нет | Нет | Нет |
| SWE-Agent | Известная проблема | Нет | Нет | Нет |
| AutoGPT | Minimal (limits) | Нет | Нет | Нет |
| Devin (Cognition) | Закрытая архитектура | Неизвестно | Неизвестно | Неизвестно |
| Claude Code Hooks | Event-driven | Нет | Нет | Нет |
| **OpenHands** | **StuckDetector** | Нет | Нет (error only) | Частично |
| AgentOps / LangSmith | Monitoring only | Нет | Нет | Нет |
| LangGraph | Manual (developer) | Нет | Частично (HITL) | Нет |
| **Microsoft AGT** | **Reasoning Loop Breaker** | **Возможно** | **Не опубликовано** | **Да** |
| **AgentCircuit** | **Fuse detector** | **Частично** | **Нет** | **Частично** |
| Portkey AI Gateway | Error rate monitoring | **Да (FSM)** | **Да** | **Нет (infra)** |

### Novelty Assessment

**Что существует:**
- Circuit breaker pattern (Nygard, 2007) — общеизвестен
- FSM-based breaker (closed → open → half-open) — стандарт для infrastructure level
- AgentCircuit / Microsoft AGT — agent-level circuit breaking (2025-2026)
- Representation-level circuit breakers (Zou et al., NeurIPS 2024) — alignment/safety

**Что ново в нашем подходе:**

| Feature | AGT | AgentCircuit | Portkey | Наш breaker |
|---------|-----|-------------|---------|-------------|
| Shell-level command monitoring | Нет | Нет | Нет | **Да** |
| Error fingerprinting + normalization | Нет | Нет | Нет | **Да** |
| Suspicious success detection | Нет | Частично | Нет | **Да (rimCoop)** |
| Semantic error classification | Нет | Нет | Нет | **Планируется** |
| Hierarchical (domain-level) breakers | Нет | Нет | Нет | **Планируется** |
| Observability debt detection | Нет | Нет | Нет | **Планируется** |
| State machine (CLOSED→OPEN→HALF-OPEN) | Возможна | Частично | **Да** | **Да** |
| Probe-based recovery | Не опубликовано | Нет | **Да** | **Да** |

**Вывод:** Полная трёхстадийная FSM (CLOSED → OPEN → HALF-OPEN) как **runtime execution control для agent reasoning loops** — с fingerprinting, probe-based recovery и suspicious success detection — **не обнаружена как единый описанный паттерн** ни в академической литературе, ни в open-source проектах. Наиболее близкий prior art — Microsoft AGT, но детали его внутренней FSM не раскрываются. Наша комбинация shell-level monitoring + error fingerprinting + suspicious success + semantic classification — уникальна.

---

<a id="recommendations"></a>
## 9. Architectural Recommendations

### Принципы

1. **Hook-compatible** — всё работает в отдельном Node.js процессе за <5ms, без ML, без external API
2. **Incremental** — каждая фича независима и может быть добавлена отдельно
3. **Backward-compatible** — новые фичи не ломают существующую state machine и тесты

### Общая архитектура

```
                    ┌──────────────────────────────────────┐
                    │         lib/common.js                │
                    │                                      │
                    │  ┌─────────────┐  ┌──────────────┐  │
                    │  │ classifyError│  │ getDomain    │  │
                    │  │ (Topic 2)   │  │ (Topic 7)   │  │
                    │  └──────┬──────┘  └──────┬───────┘  │
                    │         │                │          │
                    │  ┌──────▼──────────────────▼───────┐ │
                    │  │        semanticFailKey()        │ │
                    │  │  tool + domain + error_class    │ │
                    │  └──────────────┬─────────────────┘ │
                    │                 │                    │
                    │  ┌──────────────▼─────────────────┐ │
                    │  │     State Machine (exists)      │ │
                    │  │  CLOSED → OPEN → HALF-OPEN      │ │
                    │  └──────────────┬─────────────────┘ │
                    │                 │                    │
                    │  ┌──────────────▼─────────────────┐ │
                    │  │     New checks (additive)       │ │
                    │  │  - progressDelta (Topic 1)      │ │
                    │  │  - observabilityGap (Topic 5)    │ │
                    │  │  - costAccumulator (Topic 6)     │ │
                    │  │  - domainBreaker (Topic 7)       │ │
                    │  └────────────────────────────────┘ │
                    └──────────────────────────────────────┘
```

### Изменения в существующих файлах

| Файл | Изменение | LOC |
|------|-----------|-----|
| `lib/common.js` | + `classifyError()`, + `getDomain()`, + `progressPatterns` | +170 |
| `lib/common.js` | + `extractMetrics()`, + `detectProgress()` | +80 |
| `lib/common.js` | + `costTracking` (Pre→Post timestamp) | +60 |
| `circuit-breaker.js` | Интеграция progress detection в onFailed() | +30 |
| `circuit-breaker.js` | Domain-level breaker logic | +40 |
| `pre-flight.js` | Observability gap warning при HALF-OPEN | +25 |
| `tests/*.test.js` | Новые тесты для каждой фичи | +200 |

**Итого:** ~605 LOC дополнительно к текущим ~450 LOC = ~1055 LOC суммарно.

### State file schema extension

```json
{
  "f:Bash:dependency-management:DEPENDENCY_MISSING": {
    "count": 3,
    "lastFail": 1748901234567,
    "domain": "dependency-management",
    "errorClass": "DEPENDENCY_MISSING",
    "metrics": { "failing": 11, "passing": 89 },
    "costMs": 45000
  },
  "brk:Bash:docker build -t": {
    "status": "open",
    "since": 1748901234567,
    "reason": "failure-loop",
    "count": 3,
    "blockCount": 0,
    "domain": "containerization"
  },
  "brk:domain:containerization": {
    "status": "open",
    "tripCount": 2,
    "since": 1748901234567,
    "commands": ["docker build -t", "docker compose up"]
  }
}
```

---

<a id="roadmap"></a>
## 10. Ranked Implementation Roadmap

Ранжирование по: **Impact × Feasibility / Complexity**. Каждая фича — независимый PR.

### Phase 1: Quick Wins (1-2 дня, ~250 LOC)

| # | Фича | Topic | LOC | Impact | Почему первая |
|---|-------|-------|-----|--------|---------------|
| 1 | **Observability Gap Detection** | 5 | ~80 | ★★★★★ | Наибольшая польза/LOC. Решает rimCoop-сценарий. Детектит "blind retry" — самую частую причину loops. |
| 2 | **Numerical Progress Delta** | 1 | ~100 | ★★★★☆ | Не даёт breaker'у триггериться при продуктивной итерации. Работает для тестов/build. |
| 3 | **Semantic Error Classification** | 2 | ~110 | ★★★★☆ | 12 regex-классов покрывают 85%+ ошибок. Меняет только `failKey()` — backward-compatible. |

### Phase 2: Structural Improvements (2-3 дня, ~250 LOC)

| # | Фича | Topic | LOC | Impact | Почему вторая |
|---|-------|-------|-----|--------|---------------|
| 4 | **Domain-Level Breakers** | 7 | ~200 | ★★★★☆ | Ловит loops между разными командами в одном domain. Требует `getDomain()` (простой lookup). |
| 5 | **Time-Weighted Attempt Counting** | 6 | ~60 | ★★★☆☆ | Простая модификация: PreToolUse timestamp → PostToolUse delta → cumulative cost. |
| 6 | **Structured Recovery Template** | 4 | ~50 | ★★★☆☆ | Обязательный JSON template при recovery. Без diff validation (v2). |

### Phase 3: Synergy (1-2 дня, ~100 LOC)

| # | Фича | Topic | LOC | Impact | Почему третья |
|---|-------|-------|-----|--------|---------------|
| 7 | **Hypothesis Tracking** | 3 | ~60 | ★★★★☆ | "Бесплатно" из комбинации Topic 2 + Topic 7. `domain + errorClass × 3` = stale hypothesis. |
| 8 | **Domain-Level Observability** | 5+7 | ~40 | ★★★☆☆ | Observability gap detection на уровне domain, не только command. |

### Оценка суммарной сложности

| Метрика | Phase 1 | Phase 2 | Phase 3 | Итого |
|---------|---------|---------|---------|-------|
| LOC добавлено | ~290 | ~310 | ~100 | ~700 |
| Текущий LOC | ~450 | ~760 | ~1070 | ~1150 |
| Новых тестов | ~80 | ~80 | ~40 | ~200 |
| Риск regression | Низкий | Средний | Низкий | — |
| Зависимости | Нет | Нет | Phase 1+2 | — |

### Критерии приёмки для каждого PR

1. Все существующие тесты проходят (72+)
2. Новые тесты покрывают happy path + edge cases
3. `npm test` < 10 секунд
4. Hook overhead < 5ms на вызов
5. Backward-compatible state file (старый state работает с новым кодом)

### Чего НЕ делать

| Идея | Почему нет |
|------|-----------|
| LLM calls для plan validation | Hook должен быть <5ms, LLM call — секунды |
| Full BDI agent model | Academic overkill, 1000+ LOC |
| Embedding similarity для domain detection | Требует external API |
| Token-based cost tracking | Hook не видит API response |
| 3-level hierarchy (strategy) | Over-engineering без proven need |

---

*Конец отчёта.*
