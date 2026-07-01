package manager

import (
	"context"
	"errors"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/oauthcb"
)

// ErrLoginCanceled 表示登录被 CancelLogin 主动取消。
var ErrLoginCanceled = errors.New("manager: login canceled")

// SetPromptLogin 注入「支持手动回调 URL + 可取消」的登录实现(hub 场景)。
// 未注入时,StartLogin 退化为老的 loginFn(不可取消、无手动回调)。
func (m *Manager) SetPromptLogin(fn LoginPromptFunc) { m.loginPromptFn = fn }

// runLogin 是 StartLogin 的登录内核:优先走 loginPromptFn(ctx 可取消 + prompt
// 支持手动粘贴回调 URL),否则退化到老的 loginFn。
func (m *Manager) runLogin(ctx context.Context, st *loginState) (*account.Account, error) {
	if m.loginPromptFn != nil {
		return m.loginPromptFn(ctx, nil, m.makePrompt(ctx, st))
	}
	// 兼容路径:老 loginFn 不接受 prompt,也不响应 ctx 取消(SDK 内部 5 分钟超时)。
	return m.loginFn(ctx, nil)
}

// makePrompt 返回一个 SDK 用的 PromptFunc:当 SDK 需要手动回调 URL 时调用它,
// 它阻塞直至 SubmitLoginCallback 喂入 URL(经 st.submit),或 ctx/取消触发。
func (m *Manager) makePrompt(ctx context.Context, st *loginState) PromptFunc {
	return func(_ string) (string, error) {
		select {
		case url, ok := <-st.submit:
			if !ok {
				return "", ErrLoginCanceled
			}
			return url, nil
		case <-ctx.Done():
			return "", ErrLoginCanceled
		}
	}
}

// SubmitLoginCallback 把用户手动粘贴的回调 URL 喂给一个 pending 登录。
// 会先在本地解析校验(与 SDK 语义一致),再把原始 URL 交给 SDK 的 prompt
// 继续完成 code→token 交换。校验通过但登录未在等待手动输入时,亦不阻塞(缓冲 1)。
func (m *Manager) SubmitLoginCallback(id, callbackURL string) error {
	if _, err := oauthcb.Parse(callbackURL); err != nil {
		return err
	}
	m.mu.Lock()
	st := m.logins[id]
	m.mu.Unlock()
	if st == nil {
		return errors.New("manager: unknown login session")
	}
	select {
	case <-st.done:
		return errors.New("manager: login already finished")
	default:
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if st.closed {
		return ErrLoginCanceled
	}
	select {
	case st.submit <- callbackURL:
		return nil
	default:
		return errors.New("manager: callback already submitted")
	}
}

// CancelLogin 取消一个 pending 登录:取消底层 ctx 并关闭 submit,让阻塞中的
// prompt 立即返回。幂等:未知/已完成会话返回错误,重复取消无副作用。
func (m *Manager) CancelLogin(id string) error {
	m.mu.Lock()
	st := m.logins[id]
	m.mu.Unlock()
	if st == nil {
		return errors.New("manager: unknown login session")
	}
	m.mu.Lock()
	if st.cancel != nil {
		st.cancel()
	}
	if st.submit != nil && !st.closed {
		st.closed = true
		close(st.submit)
	}
	m.mu.Unlock()
	return nil
}
