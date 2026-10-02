import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from './supabase';

type Profile = {
  id: string;
  username: string;
  status: 'pending' | 'approved' | 'banned';
  role: 'user' | 'admin';
  tag_name: string | null;
  tag_color: string | null;
  created_at: string;
};

type Msg = {
  id: number;
  body: string;
  created_at: string;
  author_id: string;
  profiles: { username: string; tag_name: string | null; tag_color: string | null } | null;
};

const COOLDOWN = 5;

function Tag({ name, color }: { name: string | null; color: string | null }) {
  if (!name) return null;
  return <b className="tag" style={{ background: color || '#555' }}>{name}</b>;
}

/* ---------- Вход / регистрация ---------- */
function Auth() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setNote('');
    setBusy(true);
    try {
      if (mode === 'register') {
        const name = username.trim();
        const { data: taken, error: checkError } = await supabase.rpc('username_taken', { uname: name });
        if (checkError) {
          setNote('Не удалось проверить ник: ' + checkError.message);
          return;
        }
        if (taken) {
          setNote('Этот ник уже занят');
          return;
        }
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { username: name } },
        });
        if (error) {
          setNote(error.message);
          return;
        }
        setNote(
          data.session
            ? 'Заявка отправлена. Дождитесь одобрения администратора.'
            : 'Заявка создана. Подтвердите почту по письму, затем войдите.'
        );
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          setNote(error.message === 'Invalid login credentials' ? 'Неверный email или пароль' : error.message);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <h1>Наш чат</h1>
      <p>Жду тебя в нашем чате</p>
      <form onSubmit={submit}>
        {mode === 'register' && (
          <input
            required
            minLength={3}
            maxLength={24}
            placeholder="Никнейм"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        )}
        <input required type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          required
          type="password"
          minLength={8}
          placeholder="Пароль (от 8 символов)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button disabled={busy}>{mode === 'login' ? 'Войти' : 'Отправить заявку'}</button>
      </form>
      <button
        className="link"
        onClick={() => {
          setMode(mode === 'login' ? 'register' : 'login');
          setNote('');
        }}
      >
        {mode === 'login' ? 'Нет аккаунта? Подать заявку' : 'Уже есть аккаунт? Войти'}
      </button>
      {note && <p className="note">{note}</p>}
    </main>
  );
}

function Blocked({ title, text }: { title: string; text: string }) {
  return (
    <main className="auth">
      <h1>{title}</h1>
      <p>{text}</p>
      <button onClick={() => supabase.auth.signOut()}>Выйти</button>
    </main>
  );
}

/* ---------- Чат ---------- */
function Chat({ me }: { me: Profile }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [body, setBody] = useState('');
  const [wait, setWait] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    // берём 200 НОВЕЙШИХ сообщений и разворачиваем по порядку
    const { data, error } = await supabase
      .from('messages')
      .select('id, body, created_at, author_id, profiles(username, tag_name, tag_color)')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(200);
    if (error) {
      setError(error.message);
      return;
    }
    setMessages(((data ?? []) as unknown as Msg[]).reverse());
  }, []);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('chat-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => { load(); })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, () => { load(); })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (wait > 0 || sending || !text) return;
    setSending(true);
    const { error } = await supabase.rpc('send_message', { message: text });
    setSending(false);
    if (error) {
      setError(error.message);
      return;
    }
    setBody('');
    setError('');
    setWait(COOLDOWN);
    load();
  }

  async function remove(id: number) {
    if (!confirm('Удалить сообщение?')) return;
    const { error } = await supabase.from('messages').delete().eq('id', id);
    if (error) setError(error.message);
    else load();
  }

  return (
    <main className="chat">
      <header>
        <div>
          <h1>Наш чат</h1>
          <span>
            {me.username}
            <Tag name={me.tag_name} color={me.tag_color} />
          </span>
        </div>
        <div>
          {me.role === 'admin' && <a href="#admin">Админ-панель</a>}
          <button className="link" onClick={() => supabase.auth.signOut()}>Выйти</button>
        </div>
      </header>

      <section className="feed">
        {messages.map((m) => (
          <article key={m.id}>
            <div className="meta">
              <strong>{m.profiles?.username || 'Удалённый пользователь'}</strong>
              <Tag name={m.profiles?.tag_name ?? null} color={m.profiles?.tag_color ?? null} />
              <time>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              {me.role === 'admin' && (
                <button className="delete" onClick={() => remove(m.id)}>Удалить</button>
              )}
            </div>
            <p>{m.body}</p>
          </article>
        ))}
        {messages.length === 0 && <p className="empty">Пока нет сообщений</p>}
        <div ref={endRef} className="end" />
      </section>

      <form className="composer" onSubmit={send}>
        <input
          maxLength={40}
          value={body}
          placeholder="Напишите сообщение…"
          onChange={(e) => setBody(e.target.value)}
        />
        <span>{body.length}/40</span>
        <button disabled={wait > 0 || sending || !body.trim()}>
          {wait > 0 ? `Подождите ${wait} с` : 'Отправить'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </main>
  );
}

/* ---------- Админ-панель (только для админа) ---------- */
function UserRow({
  u,
  meId,
  onChange,
}: {
  u: Profile;
  meId: string;
  onChange: (id: string, patch: Partial<Profile>) => Promise<void>;
}) {
  const [tag, setTag] = useState(u.tag_name ?? '');
  const [color, setColor] = useState(u.tag_color ?? '#8b5cf6');
  const canModerate = u.id !== meId && u.role !== 'admin';
  const cleanTag = tag.trim();

  return (
    <article>
      <div className="row-head">
        <strong>{u.username}</strong>
        <Tag name={u.tag_name} color={u.tag_color} />
        {u.role === 'admin' && <small>админ</small>}
      </div>
      <div className="controls">
        {canModerate && u.status !== 'approved' && (
          <button onClick={() => onChange(u.id, { status: 'approved' })}>
            {u.status === 'banned' ? 'Разбанить' : 'Одобрить'}
          </button>
        )}
        {canModerate && u.status !== 'banned' && (
          <button className="danger" onClick={() => onChange(u.id, { status: 'banned' })}>Бан</button>
        )}
        <input maxLength={18} placeholder="Тег" value={tag} onChange={(e) => setTag(e.target.value)} />
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        <button
          onClick={() =>
            onChange(u.id, { tag_name: cleanTag || null, tag_color: cleanTag ? color : null })
          }
        >
          Сохранить тег
        </button>
      </div>
    </article>
  );
}

function Admin({ me }: { me: Profile }) {
  const [users, setUsers] = useState<Profile[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) setError(error.message);
    else setUsers((data ?? []) as Profile[]);
  }, []);

  useEffect(() => {
    load();
    // новые заявки появляются сами
    const channel = supabase
      .channel('admin-profiles')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => { load(); })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  async function update(id: string, patch: Partial<Profile>) {
    const { error } = await supabase.from('profiles').update(patch).eq('id', id);
    setError(error ? error.message : '');
    load();
  }

  const pending = users.filter((u) => u.status === 'pending');
  const approved = users.filter((u) => u.status === 'approved');
  const banned = users.filter((u) => u.status === 'banned');

  const section = (title: string, list: Profile[], empty: string) => (
    <section className="group">
      <h3>
        {title} <span className="count">{list.length}</span>
      </h3>
      {list.length === 0 && <p className="empty">{empty}</p>}
      <div className="users">
        {list.map((u) => (
          <UserRow key={u.id} u={u} meId={me.id} onChange={update} />
        ))}
      </div>
    </section>
  );

  return (
    <main className="admin">
      <header>
        <div>
          <h1>Админ-панель</h1>
          <span>{me.username}</span>
        </div>
        <div>
          <a href="#chat">← К чату</a>
          <button className="link" onClick={() => supabase.auth.signOut()}>Выйти</button>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      {section('Заявки на вход', pending, 'Новых заявок нет')}
      {section('Участники', approved, 'Пока никого')}
      {section('Забанены', banned, 'Никого')}
    </main>
  );
}

/* ---------- Корень ---------- */
export default function App() {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [hash, setHash] = useState(window.location.hash);

  const reload = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setProfile(null);
      return;
    }
    const { data } = await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    setProfile((data as Profile | null) ?? null);
  }, []);

  useEffect(() => {
    reload();
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      setTimeout(reload, 0);
    });
    return () => subscription.unsubscribe();
  }, [reload]);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // одобрили / забанили — экран меняется сам, без перезагрузки
  const uid = profile?.id;
  useEffect(() => {
    if (!uid) return;
    const channel = supabase
      .channel('me-' + uid)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${uid}` },
        () => { reload(); }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [uid, reload]);

  if (profile === undefined) return <main className="auth">Загрузка…</main>;
  if (!profile) return <Auth />;
  if (profile.status === 'pending')
    return <Blocked title="Заявка отправлена" text="Администратор ещё не подтвердил ваш аккаунт. Страница обновится сама." />;
  if (profile.status === 'banned')
    return <Blocked title="Доступ закрыт" text="Этот аккаунт заблокирован администратором." />;

  if (profile.role === 'admin' && hash === '#admin') return <Admin me={profile} />;
  return <Chat me={profile} />;
}
