# 🚀 Инструкция по обновлению бэкенда

## Шаг 1: Скопировать обновлённые файлы

Скопируйте файлы из папки `backend-updates` в `of-stats-backend`:

```
backend-updates/auth.js → of-stats-backend/src/routes/auth.js
backend-updates/database.js → of-stats-backend/src/config/database.js
backend-updates/package.json → of-stats-backend/package.json
backend-updates/migrate-fans.js → of-stats-backend/src/config/migrate-fans.js
```

## Шаг 1.5: Запустить миграцию для очистки дубликатов fans

После деплоя выполните в Railway Shell:

```bash
node src/config/migrate-fans.js
```

Или через npm:
```bash
npm run migrate-fans
```

Это удалит все дубликаты из model_fans_history и добавит уникальное ограничение.

## Шаг 2: Добавить переменные в Railway

Откройте https://railway.app → Ваш проект → Variables

Добавьте новые переменные для SMTP (email):

### Для Gmail:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=ваш-email@gmail.com
SMTP_PASS=ваш-app-password
SMTP_FROM=Stats Editor Pro <ваш-email@gmail.com>
```

### Как получить App Password для Gmail:
1. Откройте https://myaccount.google.com/security
2. Включите двухфакторную аутентификацию (если не включена)
3. Перейдите в "Пароли приложений" (App passwords)
4. Создайте новый пароль для "Mail" → "Other (Custom name)" → "Stats Editor"
5. Скопируйте 16-значный пароль в SMTP_PASS

## Шаг 3: Задеплоить на Railway

### Вариант A: Через Git (рекомендуется)
```bash
cd of-stats-backend
git add .
git commit -m "Add password reset and email notifications"
git push origin main
```

Railway автоматически задеплоит.

### Вариант B: Через Railway CLI
```bash
railway up
```

## Шаг 4: Проверить работу

После деплоя проверьте API:
```
https://stats-editor-production.up.railway.app/api/auth/login
```

---

## 📊 Схема базы данных

### Таблица `users`
| Поле | Тип | Описание |
|------|-----|----------|
| id | SERIAL | Primary key |
| email | VARCHAR(255) | Email пользователя (уникальный) |
| password_hash | VARCHAR(255) | Хэш пароля (bcrypt) |
| is_active | BOOLEAN | Активен ли аккаунт |
| email_verified | BOOLEAN | Подтверждён ли email |
| password_reset_token | VARCHAR(255) | Токен сброса пароля (хэш) |
| password_reset_expires | TIMESTAMP | Когда истекает токен |
| trial_started_at | TIMESTAMP | Начало триала |
| last_login_at | TIMESTAMP | Последний вход |
| created_at | TIMESTAMP | Дата регистрации |

### Таблица `subscriptions`
| Поле | Тип | Описание |
|------|-----|----------|
| id | SERIAL | Primary key |
| user_id | INTEGER | FK → users |
| plan | VARCHAR(50) | 'trial', 'basic', 'premium' |
| model_limit | INTEGER | Лимит моделей (10 или 50) |
| status | VARCHAR(50) | 'active', 'expired' |
| expires_at | TIMESTAMP | Когда истекает |

### Таблица `user_models`
| Поле | Тип | Описание |
|------|-----|----------|
| id | SERIAL | Primary key |
| user_id | INTEGER | FK → users |
| model_username | VARCHAR(255) | Username модели |
| display_name | VARCHAR(255) | Отображаемое имя |
| added_at | TIMESTAMP | Когда добавлена |

---

## 🔄 Как работает привязка моделей

1. **Добавление модели:**
   - Пользователь вводит @username
   - `POST /api/models` → проверка лимита
   - Если лимит не превышен → `INSERT INTO user_models`

2. **Проверка лимита:**
   ```sql
   SELECT COUNT(*) FROM user_models WHERE user_id = ?
   SELECT model_limit FROM subscriptions WHERE user_id = ? AND status = 'active'
   ```
   Если count >= model_limit → ошибка "Model limit reached"

3. **Лимиты:**
   - Trial: 10 моделей
   - Basic ($30): 10 моделей
   - Premium ($50): 50 моделей

---

## 📧 Email уведомления

Система отправляет email в следующих случаях:
1. **Регистрация** - приветственное письмо
2. **Forgot Password** - код для сброса пароля

Если SMTP не настроен, система работает без email (пишет в логи).

---

## 🔐 Безопасность

- Пароли хэшируются через bcrypt (10 rounds)
- JWT токены истекают через 7 дней
- Токены сброса пароля истекают через 1 час
- Токены сброса хранятся в хэшированном виде (SHA-256)
