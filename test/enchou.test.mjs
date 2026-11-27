/**
 * ライブのリンクの期限を延ばす（POST /enchou。src/enchou.mjs。2026-11-26 B3）。
 *
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert';
import { 期限を延ばす, 頼みを読む, 延ばせる持ち } from '../src/enchou.mjs';
import { 証の控えを忘れる } from '../src/kojin.mjs';

const 企画 = 'kyudoscoremanager';
const 今 = Date.UTC(2026, 10, 26, 3, 0, 0);
const 時間 = 3600000;
const 団体 = '265000';
const 団の枝 = 'g'.repeat(32);
const 共の枝 = 's'.repeat(64);
const 見の枝 = 'v'.repeat(64);

async function 偽のサービスアカウント() {
  const 組 = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', 組.privateKey)).toString('base64');
  return {
    type: 'service_account',
    project_id: 企画,
    client_email: `enchou@${企画}.iam.gserviceaccount.com`,
    private_key: `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`,
  };
}
const 鍵 = await 偽のサービスアカウント();
const env = { FIREBASE_SA_KEYS: JSON.stringify(鍵) };

const 欄に = (o) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [
      k,
      v === null
        ? { nullValue: null }
        : typeof v === 'boolean'
          ? { booleanValue: v }
          : { stringValue: String(v) },
    ])
  );

/**
 * 偽の雲。文書 は Firestore の道 → 欄、ライブ は Realtime Database の道 → 値。書いたもの を返す。
 * 証の範囲（datastore / firebase.database）を取り違えたら断る
 */
// 出した証と範囲（中継は証を 1 時間覚えておくので、偽の雲を作り直しても前に出した証が来る）
const 範囲 = new Map();
let 番 = 0;
function 偽の雲({ 文書 = {}, ライブ = {} } = {}) {
  const 書いたもの = [];
  const 送る = async (宛先, 頼み = {}) => {
    const 道 = String(宛先);
    if (道.startsWith('https://oauth2.googleapis.com/token')) {
      const 主張 = JSON.parse(
        Buffer.from(new URLSearchParams(頼み.body).get('assertion').split('.')[1], 'base64url').toString()
      );
      const 証 = 'tok' + ++番;
      範囲.set(証, 主張.scope);
      return new Response(JSON.stringify({ access_token: 証, expires_in: 3600 }), { status: 200 });
    }
    const 証 = String((頼み.headers || {}).Authorization || '').replace('Bearer ', '');
    if (道.startsWith('https://firestore.googleapis.com/')) {
      if (!/datastore/.test(範囲.get(証) || '')) return new Response('{}', { status: 403 });
      const 文書の道 = 道.split('/documents/')[1];
      const 中 = 文書[decodeURIComponent(文書の道)];
      return 中
        ? new Response(JSON.stringify({ fields: 欄に(中) }), { status: 200 })
        : new Response('{}', { status: 404 });
    }
    if (道.startsWith(`https://${企画}-default-rtdb.firebaseio.com/`)) {
      if (!/firebase\.database/.test(範囲.get(証) || '')) return new Response('{}', { status: 401 });
      const [道の本体, 問い = ''] = 道.split('.firebaseio.com/')[1].split('?');
      const ライブの道 = decodeURIComponent(道の本体.replace(/\.json$/, ''));
      if (頼み.method === 'PATCH') {
        書いたもの.push(JSON.parse(頼み.body));
        return new Response('{}', { status: 200 });
      }
      const 値 = ライブの道.split('/').reduce((o, k) => (o == null ? null : (o[k] ?? null)), ライブ);
      // shallow は子の名前だけ（値は true）
      const 返す =
        問い.includes('shallow=true') && 値 && typeof 値 === 'object'
          ? Object.fromEntries(Object.keys(値).map((k) => [k, true]))
          : 値;
      return new Response(JSON.stringify(返す), { status: 200 });
    }
    throw new Error('知らない宛先 ' + 道);
  };
  return { 送る, 書いたもの };
}

const 頼む = (体) =>
  new Request('https://x/enchou', {
    method: 'POST',
    body: JSON.stringify(体),
    headers: { 'Content-Type': 'application/json' },
  });
const 団体の人 = {
  aud: 企画,
  sub: 'owner-uid',
  email: 'Club@Example.com',
  email_verified: true,
  firebase: { sign_in_provider: 'password' },
};
const 部員 = { aud: 企画, sub: 'anon-1', firebase: { sign_in_provider: 'anonymous' } };
const ふつうの雲 = (足す = {}) => ({
  文書: {
    [`group_accounts/${団体}`]: { email: 'club@example.com', id: 団体, verified: true },
    [`groups/${団体}`]: { liveSecret: 団の枝 },
    'member_claims/anon-1': { groupId: 団体, memberId: 'm1' },
    [`groups/${団体}/members/m1`]: { name: '部員1', enrollment: '在籍' },
    ...(足す.文書 || {}),
  },
  ライブ: {
    live_sessions: {
      [団の枝]: {
        練習: { state: { 共有の枝: 共の枝, 閲覧の枝: 見の枝, status: 'active', 期限: 今 + 時間 } },
      },
      [共の枝]: { 練習: { state: { status: 'active', 期限: 今 + 時間, archers: [{ name: '部員1' }] } } },
    },
    live_limits: { [共の枝]: 今 + 時間, [見の枝]: 今 + 時間 },
    live_view: { [見の枝]: { 練習: { state: { 期限: 今 + 時間 } } } },
    ...(足す.ライブ || {}),
  },
});

test.beforeEach(() => 証の控えを忘れる());

test('頼みの形：団体・名前・持ち（12 時間・24 時間・7 日だけ）', () => {
  assert.deepEqual(頼みを読む({ 団体, 名前: '練習', 持ち: 24 * 時間 }), {
    団体,
    名前: '練習',
    持ち: 24 * 時間,
  });
  assert.equal(頼みを読む({ 団体, 名前: '練習', 持ち: 0 }), null, '期限なしにはできない');
  assert.equal(頼みを読む({ 団体, 名前: '練習', 持ち: 30 * 24 * 時間 }), null);
  assert.equal(頼みを読む({ 団体, 名前: '5/8', 持ち: 12 * 時間 }), null, '道を壊す字');
  assert.equal(頼みを読む({ 団体: '../x', 名前: '練習', 持ち: 12 * 時間 }), null);
  assert.deepEqual(延ばせる持ち, [12 * 時間, 24 * 時間, 7 * 24 * 時間]);
});

test('団体アカウントは延ばせる：配った枝と閲覧の枝の期限・盤面・写し・道しるべの期限を書く', async () => {
  const 雲 = 偽の雲(ふつうの雲());
  const 結果 = await 期限を延ばす(頼む({ 団体, 名前: '練習', 持ち: 24 * 時間 }), env, 団体の人, {
    送る: 雲.送る,
    今,
  });
  assert.deepEqual(結果, { 状態: 200, 中身: { 結果: '延ばした', 期限: 今 + 24 * 時間 } });
  assert.equal(雲.書いたもの.length, 1, 'まとめて 1 回で書く');
  assert.deepEqual(雲.書いたもの[0], {
    [`live_limits/${共の枝}`]: 今 + 24 * 時間,
    [`live_limits/${見の枝}`]: 今 + 24 * 時間,
    [`live_sessions/${共の枝}/練習/state/期限`]: 今 + 24 * 時間,
    [`live_sessions/${団の枝}/練習/state/期限`]: 今 + 24 * 時間,
    [`live_view/${見の枝}/練習/state/期限`]: 今 + 24 * 時間,
  });
});

test('在籍している部員は延ばせる。退部・卒業・よその団体・所属の証の無い人は断る', async () => {
  const 体 = { 団体, 名前: '練習', 持ち: 12 * 時間 };
  assert.equal((await 期限を延ばす(頼む(体), env, 部員, { 送る: 偽の雲(ふつうの雲()).送る, 今 })).状態, 200);
  for (const enrollment of ['退部', '卒業']) {
    const 雲 = 偽の雲(ふつうの雲({ 文書: { [`groups/${団体}/members/m1`]: { name: '部員1', enrollment } } }));
    const 結果 = await 期限を延ばす(頼む(体), env, 部員, { 送る: 雲.送る, 今 });
    assert.equal(結果.状態, 403, enrollment + 'の人が延ばせた');
    assert.equal(雲.書いたもの.length, 0);
  }
  const よそ = 偽の雲(
    ふつうの雲({ 文書: { 'member_claims/anon-1': { groupId: '999999', memberId: 'm1' } } })
  );
  assert.equal((await 期限を延ばす(頼む(体), env, 部員, { 送る: よそ.送る, 今 })).状態, 403);
  const 来客 = { aud: 企画, sub: 'anon-x', firebase: { sign_in_provider: 'anonymous' } };
  assert.equal(
    (await 期限を延ばす(頼む(体), env, 来客, { 送る: 偽の雲(ふつうの雲()).送る, 今 })).状態,
    403,
    'リンクで来た人'
  );
  const 確かめていない = { ...団体の人, email_verified: false };
  assert.equal(
    (await 期限を延ばす(頼む(体), env, 確かめていない, { 送る: 偽の雲(ふつうの雲()).送る, 今 })).状態,
    403
  );
});

test('配っていない・期限が切れた・今より短いは断る。写しが無ければ写しには書かない', async () => {
  const 体 = { 団体, 名前: '練習', 持ち: 12 * 時間 };
  const 配っていない = 偽の雲(
    ふつうの雲({ ライブ: { live_sessions: { [団の枝]: { 練習: { state: { status: 'active' } } } } } })
  );
  assert.equal((await 期限を延ばす(頼む(体), env, 団体の人, { 送る: 配っていない.送る, 今 })).状態, 404);
  const 切れた = 偽の雲(ふつうの雲({ ライブ: { live_limits: { [共の枝]: 今 - 1 } } }));
  assert.equal((await 期限を延ばす(頼む(体), env, 団体の人, { 送る: 切れた.送る, 今 })).状態, 410);
  const 長い = 偽の雲(ふつうの雲({ ライブ: { live_limits: { [共の枝]: 今 + 6 * 24 * 時間 } } }));
  const 短い = await 期限を延ばす(頼む({ ...体, 持ち: 24 * 時間 }), env, 団体の人, { 送る: 長い.送る, 今 });
  assert.equal(短い.状態, 409);
  assert.equal(長い.書いたもの.length, 0);
  const 写しなし = 偽の雲(ふつうの雲({ ライブ: { live_view: {} } }));
  assert.equal((await 期限を延ばす(頼む(体), env, 団体の人, { 送る: 写しなし.送る, 今 })).状態, 200);
  assert.equal(
    `live_view/${見の枝}/練習/state/期限` in 写しなし.書いたもの[0],
    false,
    '無い写しに期限を書いた'
  );
});

test('鍵が無ければ 404（古い中継と同じ）・Realtime Database に書けなければ 503', async () => {
  assert.equal((await 期限を延ばす(頼む({ 団体, 名前: '練習', 持ち: 12 * 時間 }), {}, 団体の人)).状態, 404);
  const 雲 = 偽の雲(ふつうの雲());
  const 書けない = async (宛先, 頼み = {}) =>
    頼み.method === 'PATCH' ? new Response('{}', { status: 401 }) : 雲.送る(宛先, 頼み);
  const 結果 = await 期限を延ばす(頼む({ 団体, 名前: '練習', 持ち: 12 * 時間 }), env, 団体の人, {
    送る: 書けない,
    今,
  });
  assert.equal(結果.状態, 503);
});

test('共有の盤面がもう無い・保存して終わった（片付けの途中）なら書かない（11/27 の点検）', async () => {
  const 体 = { 団体, 名前: '練習', 持ち: 12 * 時間 };
  const 道しるべ = {
    練習: { state: { 共有の枝: 共の枝, 閲覧の枝: 見の枝, status: 'active', 期限: 今 + 時間 } },
  };
  for (const [訳, 共の盤面] of [
    ['盤面が無い', {}],
    ['保存して終わった', { 練習: { state: { status: 'finished' } } }],
  ]) {
    const 雲 = 偽の雲(ふつうの雲({ ライブ: { live_sessions: { [団の枝]: 道しるべ, [共の枝]: 共の盤面 } } }));
    const 結果 = await 期限を延ばす(頼む(体), env, 団体の人, { 送る: 雲.送る, 今 });
    assert.equal(結果.状態, 404, 訳);
    assert.equal(雲.書いたもの.length, 0, 訳 + 'なのに書いた');
  }
});

test('部員は、4 桁の個人ID の証なら 12/3 から・団体のメールが確認前なら猶予のあと延ばせない（決まりの isClaimedMember と同じ。11/28）', async () => {
  const 体 = { 団体, 名前: '練習', 持ち: 12 * 時間 };
  const 四桁 = { 文書: { 'member_claims/anon-1': { groupId: 団体, memberId: 'm1', personalId: '1234' } } };
  const 十二月二日 = Date.UTC(2026, 11, 2, 12, 0, 0);
  const 十二月三日 = Date.UTC(2026, 11, 3, 0, 0, 0);
  const 延ばす = (足す, 時) => {
    const 雲 = ふつうの雲(足す);
    // 期限を「今」に合わせる（期限切れで断られないように）
    雲.ライブ.live_limits = { [共の枝]: 時 + 時間, [見の枝]: 時 + 時間 };
    return 期限を延ばす(頼む(体), env, 部員, { 送る: 偽の雲(雲).送る, 今: 時 });
  };
  assert.equal((await 延ばす(四桁, 十二月二日)).状態, 200, '12/2 までは 4 桁でも延ばせる');
  assert.equal((await 延ばす(四桁, 十二月三日)).状態, 403, '12/3 から 4 桁の証で延ばせた');
  const 確認前 = { 文書: { [`group_accounts/${団体}`]: { email: 'club@example.com', id: 団体 } } };
  assert.equal((await 延ばす(確認前, 今)).状態, 403, '団体のメールが確認前（猶予のあと）なのに延ばせた');
  assert.equal((await 延ばす(確認前, Date.UTC(2026, 10, 9))).状態, 200, '猶予のあいだは延ばせる');
});
