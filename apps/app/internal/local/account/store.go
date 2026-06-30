package account

import (
	"database/sql"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, err
	}
	// 前向迁移:旧库补列(已存在则忽略错误)。
	_, _ = db.Exec(`ALTER TABLE local_accounts ADD COLUMN project_id TEXT`)
	_, _ = db.Exec(`ALTER TABLE local_accounts ADD COLUMN name TEXT`)
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

const schema = `
CREATE TABLE IF NOT EXISTS local_accounts (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, email TEXT, auth_kind TEXT,
  id_token TEXT, access_token TEXT, refresh_token TEXT, api_key TEXT, api_base_url TEXT,
  account_id TEXT, plan_type TEXT, tags TEXT, note TEXT,
  pool_enabled INTEGER, priority INTEGER, quota_status TEXT, quota_reason TEXT,
  hourly_percent INTEGER, weekly_percent INTEGER, hourly_reset_at INTEGER, weekly_reset_at INTEGER,
  blocked_until INTEGER, created_at INTEGER, last_used_at INTEGER, updated_at INTEGER, project_id TEXT, name TEXT
);`

const allCols = `id,provider,email,auth_kind,id_token,access_token,refresh_token,api_key,api_base_url,
  account_id,plan_type,tags,note,pool_enabled,priority,quota_status,quota_reason,
  hourly_percent,weekly_percent,hourly_reset_at,weekly_reset_at,blocked_until,created_at,last_used_at,updated_at,project_id,name`

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (s *Store) Add(a *Account) error {
	if a.ID == "" {
		a.ID = uuid.NewString()
	}
	now := time.Now().UnixMilli()
	if a.CreatedAt == 0 {
		a.CreatedAt = now
	}
	a.UpdatedAt = now
	tags, _ := json.Marshal(a.Tags)
	_, err := s.db.Exec(`INSERT INTO local_accounts (`+allCols+`)
	  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		a.ID, a.Provider, a.Email, a.AuthKind, a.IDToken, a.AccessToken, a.RefreshToken, a.APIKey, a.APIBaseURL,
		a.AccountID, a.PlanType, string(tags), a.Note, b2i(a.PoolEnabled), b2i(a.Priority), a.QuotaStatus, a.QuotaReason,
		a.HourlyPercent, a.WeeklyPercent, a.HourlyResetAt, a.WeeklyResetAt, a.BlockedUntil, a.CreatedAt, a.LastUsedAt, a.UpdatedAt, a.ProjectID, a.Name)
	return err
}

func (s *Store) Update(a *Account) error {
	a.UpdatedAt = time.Now().UnixMilli()
	tags, _ := json.Marshal(a.Tags)
	_, err := s.db.Exec(`UPDATE local_accounts SET email=?,auth_kind=?,id_token=?,access_token=?,refresh_token=?,
	  api_key=?,api_base_url=?,account_id=?,plan_type=?,tags=?,note=?,pool_enabled=?,priority=?,quota_status=?,
	  quota_reason=?,hourly_percent=?,weekly_percent=?,hourly_reset_at=?,weekly_reset_at=?,blocked_until=?,
	  last_used_at=?,updated_at=?,project_id=?,name=? WHERE id=?`,
		a.Email, a.AuthKind, a.IDToken, a.AccessToken, a.RefreshToken, a.APIKey, a.APIBaseURL, a.AccountID, a.PlanType,
		string(tags), a.Note, b2i(a.PoolEnabled), b2i(a.Priority), a.QuotaStatus, a.QuotaReason, a.HourlyPercent,
		a.WeeklyPercent, a.HourlyResetAt, a.WeeklyResetAt, a.BlockedUntil, a.LastUsedAt, a.UpdatedAt, a.ProjectID, a.Name, a.ID)
	return err
}

func (s *Store) Get(id string) (*Account, error) {
	rows, err := s.db.Query(`SELECT `+allCols+` FROM local_accounts WHERE id=?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list, err := scan(rows)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, sql.ErrNoRows
	}
	return list[0], nil
}

func (s *Store) List(p Provider) ([]*Account, error) {
	rows, err := s.db.Query(`SELECT `+allCols+` FROM local_accounts WHERE provider=? ORDER BY created_at`, p)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scan(rows)
}

func (s *Store) ListPoolEnabled(p Provider) ([]*Account, error) {
	rows, err := s.db.Query(`SELECT `+allCols+` FROM local_accounts WHERE provider=? AND pool_enabled=1 ORDER BY created_at`, p)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scan(rows)
}

func (s *Store) Delete(id string) error {
	_, err := s.db.Exec(`DELETE FROM local_accounts WHERE id=?`, id)
	return err
}

func scan(rows *sql.Rows) ([]*Account, error) {
	var out []*Account
	for rows.Next() {
		var a Account
		var tags string
		var pool, prio int
		var name sql.NullString
		if err := rows.Scan(&a.ID, &a.Provider, &a.Email, &a.AuthKind, &a.IDToken, &a.AccessToken, &a.RefreshToken,
			&a.APIKey, &a.APIBaseURL, &a.AccountID, &a.PlanType, &tags, &a.Note, &pool, &prio, &a.QuotaStatus,
			&a.QuotaReason, &a.HourlyPercent, &a.WeeklyPercent, &a.HourlyResetAt, &a.WeeklyResetAt, &a.BlockedUntil,
			&a.CreatedAt, &a.LastUsedAt, &a.UpdatedAt, &a.ProjectID, &name); err != nil {
			return nil, err
		}
		a.Name = name.String
		a.PoolEnabled = pool == 1
		a.Priority = prio == 1
		if tags != "" {
			_ = json.Unmarshal([]byte(tags), &a.Tags)
		}
		out = append(out, &a)
	}
	return out, rows.Err()
}
