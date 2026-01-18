# Happy Farmer 2000 — Архитектура

## 🌐 API (Все GET)

| Endpoint | Описание |
|----------|----------|
| `/plant?plot_id=1&crop=tomato` | Посадить |
| `/harvest?id=1` | Собрать |
| `/water?id=1` | Полить |
| `/remove_pest?id=1` | Убрать вредителя |
| `/feed?id=1` | Покормить |
| `/collect?id=1` | Собрать продукцию |
| `/cure?id=1` | Вылечить |
| `/start?id=1&recipe=bread` | Запустить фабрику |
| `/buy?type=cow` | Купить |
| `/sell?item=wheat&qty=10` | Продать |
| `/steal?id=1` | Украсть |
| `/throw_pest?id=1` | Подбросить вредителя |
| `/add_friend?id=123` | Добавить друга |
| `/bank/loan?amount=1000` | Взять кредит |
| `/bank/repay` | Погасить кредит |
| `/bank/deposit?amount=500` | Положить на депозит |
| `/bank/withdraw` | Снять депозит |

---

## ⏱️ Checkpoints

При создании объекта рассчитываются ВСЕ будущие события:

```typescript
[
  { time: 60,  action: 'water',      deadline: 1860 },
  { time: 180, action: 'remove_pest', deadline: 780 },
  { time: 420, action: 'harvest',     deadline: 4020 }
]
```

---

## 💾 БД — 7 Таблиц

```sql
-- 1. users (уже есть)

-- 2. Имущество пользователя
CREATE TABLE user_stats (
  user_id BIGINT REFERENCES users(id),
  key TEXT NOT NULL,
  value INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(user_id, key)
);

-- 3. Действия пользователя (лог)
CREATE TABLE user_actions (
  id SERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  object_id INTEGER,
  target_user_id BIGINT,
  data TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Друзья
CREATE TABLE user_friends (
  user_id BIGINT REFERENCES users(id),
  friend_id BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(user_id, friend_id)
);

-- 5. Игровые объекты
CREATE TABLE game_objects (
  id SERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id),
  type_code TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  x INTEGER,
  y INTEGER
);

-- 6. Параметры объектов (EAV)
CREATE TABLE game_object_params (
  object_id INTEGER REFERENCES game_objects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(object_id, key)
);

-- 7. Checkpoints
CREATE TABLE game_checkpoints (
  id SERIAL PRIMARY KEY,
  object_id INTEGER REFERENCES game_objects(id) ON DELETE CASCADE,
  time_offset INTEGER NOT NULL,
  action TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  done_at TIMESTAMPTZ,
  done_by BIGINT REFERENCES users(id)
);
```

---

## 📁 Конфиги

Типы читаются из `docs/assets/{category}/{code}/config.json`:

```json
{
  "name": "Помидор",
  "category": "crop",
  "stage_times": [60, 120, 180, 60],
  "wither_time": 3600,
  "buy_silver": 15,
  "sell_silver": 40,
  "exp": 10,
  "level": 3,
  "yield": [3, 5],
  "steal_percent": 20
}
```

---

## 🏦 Банк

Используем `user_stats`:
- `loan_amount`, `loan_taken_at` — кредит
- `deposit_amount`, `deposit_at` — депозит

Проценты: кредит 5%/день, депозит 2%/день.
