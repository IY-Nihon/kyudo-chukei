/**
 * 部員（自分）の記録（POST /jibun。src/jibun.mjs）。3 段目・2026-11-19。
 *
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert';
import {
  自分の記録を返す,
  自分の行だけにする,
  他の人,
  ページ,
  初めの件,
  idの上限,
  確かめの控えを忘れる,
} from '../src/jibun.mjs';
import { 証の控えを忘れる, 猶予の終わり } from '../src/kojin.mjs';

const 企画 = 'kyudoscoremanager';
const 根の名 = `projects/${企画}/databases/(default)/documents`;

/** テスト用のサービスアカウント（本物の RSA の鍵。署名だけ使う） */
async function 偽のサービスアカウント() {
  const 組 = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', 組.privateKey)).toString('base64');
  return {
    type: 'service_account',
    project_id: 企画,
    client_email: `jibun@${企画}.iam.gserviceaccount.com`,
    private_key: `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`,
  };
}

// ── Firestore の REST の値を作る ──
const 値 = (v) => {
  if (v === null) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(値) } };
  return { mapValue: { fields: 欄に(v) } };
};
const 欄に = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, 値(v)]));

/** 偽の雲。文書 は 道（/groups/…）→ ふつうの値の表 */
function 偽の雲(文書) {
  const 問い合わせ = [];
  const 読んだ道 = [];
  const 時 = (欄) => (欄 && 欄.lastModified && 欄.lastModified.timestampValue ? Date.parse(欄.lastModified.timestampValue) : null);
  const 送る = async (url, 頼み = {}) => {
    if (url === 'https://oauth2.googleapis.com/token')
      return new Response(JSON.stringify({ access_token: 'sa-token', expires_in: 3600 }), { status: 200 });
    assert.strictEqual(頼み.headers.Authorization, 'Bearer sa-token', 'サービスアカウントの証で読んでいない');
    const 道 = decodeURIComponent(url.replace(/^.*\/documents/, ''));
    if (頼み.method === 'POST' && 道 === ':batchGet') {
      const 名たち = JSON.parse(頼み.body).documents;
      return new Response(
        JSON.stringify(
          名たち.map((名) => {
            const 短い = 名.replace(根の名, '');
            return 文書[短い] ? { found: { name: 名, fields: 欄に(文書[短い]) } } : { missing: 名 };
          })
        ),
        { status: 200 }
      );
    }
    if (頼み.method === 'POST' && 道.endsWith(':runQuery')) {
      const 問い = JSON.parse(頼み.body).structuredQuery;
      問い合わせ.push(問い);
      const 前 = 道.replace(/:runQuery$/, '') + '/' + 問い.from[0].collectionId + '/';
      let 行 = Object.entries(文書)
        .filter(([鍵]) => 鍵.startsWith(前) && !鍵.slice(前.length).includes('/'))
        .map(([鍵, 中]) => ({ name: 根の名 + 鍵, fields: 欄に(中) }));
      if (問い.where) {
        const 下 = Date.parse(問い.where.fieldFilter.value.timestampValue);
        行 = 行.filter((d) => 時(d.fields) !== null && 時(d.fields) >= 下);
      }
      const 鍵 = (d, o) => (o.field.fieldPath === '__name__' ? d.name : 時(d.fields) ?? -Infinity);
      const 比べ = (甲, 乙) => {
        for (const o of 問い.orderBy || []) {
          const [x, y] = [鍵(甲, o), 鍵(乙, o)];
          if (x !== y) return (x < y ? -1 : 1) * (o.direction === 'DESCENDING' ? -1 : 1);
        }
        return 0;
      };
      行.sort(比べ);
      if (問い.startAt) {
        const 印 = 問い.startAt.values.map((v) => (v.referenceValue ? v.referenceValue : Date.parse(v.timestampValue)));
        const 印の行 = { name: '', fields: {} };
        行 = 行.filter((d) => {
          for (let i = 0; i < 問い.orderBy.length; i++) {
            const x = 鍵(d, 問い.orderBy[i]);
            if (x !== 印[i]) return x > 印[i];
          }
          return false; // 同じ位置は含めない（before: false）
        });
        void 印の行;
      }
      if (問い.limit) 行 = 行.slice(0, 問い.limit);
      if (問い.select) {
        const 残す = 問い.select.fields.map((f) => f.fieldPath);
        行 = 行.map((d) => ({ name: d.name, fields: Object.fromEntries(Object.entries(d.fields).filter(([k]) => 残す.includes(k))) }));
      }
      return new Response(JSON.stringify(行.map((d) => ({ document: d, readTime: '2026-11-19T00:00:00Z' }))), { status: 200 });
    }
    読んだ道.push(道);
    const 中 = 文書[道];
    if (!中) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ name: 根の名 + 道, fields: 欄に(中) }), { status: 200 });
  };
  return { 送る, 問い合わせ, 読んだ道 };
}

const 団体 = '100001';
const 本人 = { sub: 'anon-1', aud: 企画, firebase: { sign_in_provider: 'anonymous' } };
const 頼み = (体) =>
  new Request('https://chukei/jibun', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(体),
  });
const 時 = (ms) => new Date(Date.parse('2026-11-19T00:00:00Z') + ms);

/** 自分（m1・山田 太郎）の写った記録・写っていない記録・ゴミ箱のある団体 */
function 団体の文書(足す = {}) {
  return {
    [`/member_claims/${本人.sub}`]: { groupId: 団体, memberId: 'm1', personalId: 'K7MP3X' },
    [`/group_accounts/${団体}`]: { verified: true },
    [`/groups/${団体}/members/m1`]: { id: 'm1', name: '山田 太郎' },
    [`/groups/${団体}/sessions/s1`]: {
      title: '練習',
      note: 'メモ',
      date: 時(0),
      tags: ['#立'],
      shotCount: 4,
      includeInStats: true,
      lastModified: 時(1000),
      archerNames: ['山田 太郎', '佐藤 花子'],
      attendance: { m1: 'present', m2: 'late' },
      archers: [
        { id: 'a1', name: '山田 太郎', memberId: 'm1', marks: ['○', '×', '○', '○'], bowWeight: 12 },
        { id: 'a2', name: '佐藤 花子', memberId: 'm2', marks: ['○', '○', '○', '○'] },
        { id: 'sep', isSeparator: true, name: '相手校' },
      ],
    },
    [`/groups/${団体}/sessions/s2`]: {
      title: 'ほかの人だけ',
      date: 時(0),
      lastModified: 時(2000),
      archers: [{ id: 'b1', name: '佐藤 花子', memberId: 'm2', marks: ['○'] }],
    },
    [`/groups/${団体}/trash/s9`]: { lastModified: 時(500), archers: [] },
    ...足す,
  };
}

async function 呼ぶ(体, 文書 = 団体の文書(), 本人を替える = {}, 控えを残す = false) {
  証の控えを忘れる();
  if (!控えを残す) 確かめの控えを忘れる();
  const 雲 = 偽の雲(文書);
  const env = { FIREBASE_SA_KEYS: JSON.stringify({ [企画]: await 偽のサービスアカウント() }) };
  const 結果 = await 自分の記録を返す(頼み(体), env, { ...本人, ...本人を替える }, { 送る: 雲.送る, 今: Date.parse('2026-11-20T00:00:00Z') });
  return { ...結果, 雲 };
}

test('その人の行だけにする：ほかの人の列は空・自分の列の交代の相手の射も空・出欠と名前の一覧は自分だけ', () => {
  const 記録 = {
    id: 's1',
    title: '練習',
    attendance: { m1: 'present', m2: 'late' },
    archerNames: ['山田 太郎', '佐藤 花子', '鈴木 一'],
    secret: 'ほかの欄は渡さない',
    archers: [
      // 自分の列。3 射目から鈴木（m3）に交代
      {
        id: 'a1',
        name: '山田 太郎',
        memberId: 'm1',
        marks: ['○', '×', '○', '○'],
        substitutions: { 2: '鈴木 一' },
        substitutionIds: { 2: 'm3' },
        bowWeight: 12,
      },
      // ほかの人の列。2 射目から自分が入った
      { id: 'a2', name: '佐藤 花子', memberId: 'm2', marks: ['○', '○', '×', '○'], substitutions: { 1: '山田 太郎' }, substitutionIds: { 1: 'm1' } },
      { id: 'a3', name: '鈴木 一', memberId: 'm3', marks: ['○'], bowWeight: 14 },
      { id: 'sep', isSeparator: true, name: '相手校' },
    ],
  };
  const 出 = 自分の行だけにする(記録, 'm1', '山田 太郎');
  assert.deepStrictEqual(Object.keys(出).sort(), ['archerNames', 'archers', 'attendance', 'id', 'title'].sort());
  assert.deepStrictEqual(出.attendance, { m1: 'present' });
  assert.deepStrictEqual(出.archerNames, ['山田 太郎']);
  const [自分, 入った, ほか, 区切り] = 出.archers;
  assert.deepStrictEqual(自分.marks, ['○', '×', '', ''], '交代の相手（鈴木）の射が残っている');
  assert.strictEqual(自分.substitutions[2], 他の人);
  assert.strictEqual(自分.bowWeight, 12);
  assert.deepStrictEqual(入った.marks, ['', '○', '×', '○'], '自分が入ったあとの射だけ残す');
  assert.strictEqual(入った.name, 他の人);
  assert.strictEqual(入った.memberId, undefined);
  assert.deepStrictEqual(ほか, { id: 'a3', name: '', marks: [], substitutions: {}, substitutionIds: {}, isGuest: false });
  assert.deepStrictEqual(区切り, { id: 'sep', name: '', marks: [], substitutions: {}, substitutionIds: {}, isGuest: false, isSeparator: true });
  // 写っていない記録は null。部員 ID の無い列は名前で拾う
  assert.strictEqual(自分の行だけにする({ id: 's2', archers: [{ name: '佐藤 花子', memberId: 'm2' }] }, 'm1', '山田 太郎'), null);
  assert.ok(自分の行だけにする({ id: 's3', archers: [{ name: '山田 太郎', marks: ['○'] }] }, 'm1', '山田 太郎'));
  // 同姓同名でも、別の部員 ID の列は自分にしない
  assert.strictEqual(自分の行だけにする({ id: 's4', archers: [{ name: '山田 太郎', memberId: 'm9' }] }, 'm1', '山田 太郎'), null);
});

test('差分：自分の写った記録を絞って返し、写っていない記録は外す。ゴミ箱へ移った記録と境目も返す', async () => {
  const { 状態, 中身, 雲 } = await 呼ぶ({ 団体, 形: '差分', 境目: { 記録: 0, ごみ箱: 0 } });
  assert.strictEqual(状態, 200);
  assert.deepStrictEqual(中身.記録.map((r) => r.id), ['s1']);
  assert.deepStrictEqual(中身.外す, ['s2']);
  assert.deepStrictEqual(中身.消えた, [{ id: 's9', 時: 時(500).getTime() }]);
  assert.deepStrictEqual(中身.境目, { 記録: 時(2000).getTime(), ごみ箱: 時(500).getTime() });
  assert.strictEqual(中身.続き, null);
  const s1 = 中身.記録[0];
  assert.strictEqual(s1.date, 時(0).getTime(), '日時をミリ秒にしていない');
  assert.deepStrictEqual(s1.archers[1].marks, [], 'ほかの人の ○× が渡っている');
  assert.deepStrictEqual(s1.attendance, { m1: 'present' });
  // ゴミ箱は id と時刻だけ読む
  assert.deepStrictEqual(雲.問い合わせ[1].select, { fields: [{ fieldPath: 'lastModified' }] });
  // 境目より前の記録は読まない
  const 後 = await 呼ぶ({ 団体, 形: '差分', 境目: { 記録: 時(1500).getTime(), ごみ箱: 時(600).getTime() } });
  assert.deepStrictEqual(後.中身.記録, []);
  assert.deepStrictEqual(後.中身.外す, ['s2']);
  assert.deepStrictEqual(後.中身.消えた, []);
});

test('差分・全部はページに分けて返し、続きで次のページを読む', async () => {
  const 多い = {};
  for (let i = 0; i < ページ + 5; i++)
    多い[`/groups/${団体}/sessions/x${String(i).padStart(2, '0')}`] = {
      lastModified: 時(10000 + Math.floor(i / 2)), // 同じ時刻の記録も混ぜる（続きは時刻と名前で決める）
      archers: [{ id: 'a', name: '山田 太郎', memberId: 'm1', marks: ['○'] }],
    };
  const 文書 = 団体の文書(多い);
  for (const 形 of ['差分', '全部']) {
    const 一 = await 呼ぶ({ 団体, 形, 境目: { 記録: 時(5000).getTime() }, 件: ページ }, 文書);
    assert.strictEqual(一.状態, 200, 形);
    assert.strictEqual(一.中身.記録.length + 一.中身.外す.length, ページ, `${形}：1 ページの数`);
    assert.ok(一.中身.続き, `${形}：続きが無い`);
    const 二 = await 呼ぶ({ 団体, 形, 境目: { 記録: 時(5000).getTime() }, 続き: 一.中身.続き, 件: ページ }, 文書);
    assert.strictEqual(二.状態, 200, 形);
    assert.strictEqual(二.中身.続き, null, `${形}：最後のページなのに続きがある`);
    const 全部のid = [...一.中身.記録, ...二.中身.記録].map((r) => r.id).concat(一.中身.外す, 二.中身.外す);
    assert.strictEqual(new Set(全部のid).size, 全部のid.length, `${形}：同じ記録を 2 度返した`);
    const 期待 = 形 === '差分' ? ページ + 5 : ページ + 5 + 2; // 全部は s1・s2 も入る
    assert.strictEqual(全部のid.length, 期待, `${形}：取りこぼし`);
    // 続きのページではゴミ箱を読み直さない
    assert.deepStrictEqual(二.中身.消えた, []);
  }
  // 全部の最初のページでは、ゴミ箱の境目（いちばん新しい時刻）も返す
  const 全部 = await 呼ぶ({ 団体, 形: '全部' });
  assert.strictEqual(全部.中身.境目.ごみ箱, 時(500).getTime());
});

test('id：自分の写った記録は絞って返し、写っていない・無い記録は外す', async () => {
  const { 状態, 中身 } = await 呼ぶ({ 団体, 形: 'id', ids: ['s1', 's2', 'none'] });
  assert.strictEqual(状態, 200);
  assert.deepStrictEqual(中身.記録.map((r) => r.id), ['s1']);
  assert.deepStrictEqual(中身.外す.sort(), ['none', 's2']);
});

test('断る：鍵が無い（404）・匿名でない・所属の証が無いか別の団体・名簿にいない・確認がまだ・形が違う・続きが別の団体', async () => {
  証の控えを忘れる();
  const 鍵なし = await 自分の記録を返す(頼み({ 団体, 形: '差分' }), {}, 本人, {});
  assert.strictEqual(鍵なし.状態, 404);
  assert.strictEqual((await 呼ぶ({ 団体, 形: '差分' }, 団体の文書(), { firebase: { sign_in_provider: 'password' } })).状態, 403);
  assert.strictEqual((await 呼ぶ({ 団体: '100002', 形: '差分' })).状態, 403, '別の団体の記録を読めた');
  const 証なし = 団体の文書();
  delete 証なし[`/member_claims/${本人.sub}`];
  assert.strictEqual((await 呼ぶ({ 団体, 形: '差分' }, 証なし)).状態, 403);
  const 名簿なし = 団体の文書();
  delete 名簿なし[`/groups/${団体}/members/m1`];
  assert.strictEqual((await 呼ぶ({ 団体, 形: '差分' }, 名簿なし)).状態, 403);
  const 確認まだ = 団体の文書({ [`/group_accounts/${団体}`]: { verified: false } });
  assert.ok(Date.parse('2026-11-20T00:00:00Z') > 猶予の終わり);
  assert.strictEqual((await 呼ぶ({ 団体, 形: '差分' }, 確認まだ)).状態, 403);
  const 四桁 = 団体の文書({ [`/member_claims/${本人.sub}`]: { groupId: 団体, memberId: 'm1', personalId: '1234' } });
  assert.strictEqual((await 呼ぶ({ 団体, 形: '差分' }, 四桁)).状態, 200, '12/3 より前の 4 桁は通す');
  assert.strictEqual((await 呼ぶ({ 団体, 形: 'ぜんぶ' })).状態, 400);
  assert.strictEqual((await 呼ぶ({ 団体, 形: 'id', ids: [] })).状態, 400);
  assert.strictEqual(
    (await 呼ぶ({ 団体, 形: '全部', 続き: { 名: `${根の名}/groups/100002/sessions/x` } })).状態,
    400,
    'ほかの団体の続きを受けた'
  );
});

test('日本語や % を含む id の記録・メンバーも扱う（Firestore の id は / 以外の字を使える。検証環境に実在する。11/20）', async () => {
  const 和 = 'ses-型検証-%41';
  const 他 = '他-%zz';
  const 文書 = 団体の文書({
    [`/groups/${団体}/sessions/${和}`]: {
      lastModified: 時(3000),
      archers: [{ id: 'a', name: '山田 太郎', memberId: 'm1', marks: ['○'] }],
    },
    [`/groups/${団体}/sessions/${他}`]: {
      lastModified: 時(3000),
      archers: [{ id: 'b', name: '佐藤 花子', memberId: 'm2', marks: ['○'] }],
    },
  });
  const 差分 = await 呼ぶ({ 団体, 形: '差分', 境目: { 記録: 時(2500).getTime() } }, 文書);
  assert.strictEqual(差分.状態, 200);
  assert.deepStrictEqual(差分.中身.記録.map((r) => r.id), [和], '% を戻して id を壊した');
  assert.deepStrictEqual(差分.中身.外す, [他]);
  const id = await 呼ぶ({ 団体, 形: 'id', ids: [和, 他, '無い-日本語'] }, 文書);
  assert.strictEqual(id.状態, 200, '日本語の id を断った');
  assert.deepStrictEqual(id.中身.記録.map((r) => r.id), [和]);
  assert.deepStrictEqual(id.中身.外す.sort(), [他, '無い-日本語'].sort());
  // 続きの名前に日本語の id（ページの切れ目がこの記録でも続きを読める）
  const 続き = await 呼ぶ({ 団体, 形: '全部', 続き: { 名: `${根の名}/groups/${団体}/sessions/${和}` } }, 文書);
  assert.strictEqual(続き.状態, 200, '日本語の id の続きを断った');
  // / を含む id・続きは断る
  assert.strictEqual((await 呼ぶ({ 団体, 形: 'id', ids: ['a/b'] }, 文書)).状態, 400);
  assert.strictEqual(
    (await 呼ぶ({ 団体, 形: '全部', 続き: { 名: `${根の名}/groups/${団体}/sessions/a/b` } }, 文書)).状態,
    400
  );
  // メンバーの id が日本語でも、名簿を読めて自分の行が分かる
  const 和の人 = 団体の文書({
    [`/member_claims/${本人.sub}`]: { groupId: 団体, memberId: '部員-一', personalId: 'K7MP3X' },
    [`/groups/${団体}/members/部員-一`]: { id: '部員-一', name: '鈴木 一' },
    [`/groups/${団体}/sessions/s7`]: {
      lastModified: 時(4000),
      archers: [{ id: 'c', name: '鈴木 一', memberId: '部員-一', marks: ['×'] }],
    },
  });
  const 和の答え = await 呼ぶ({ 団体, 形: '差分', 境目: { 記録: 時(3500).getTime() } }, 和の人);
  assert.strictEqual(和の答え.状態, 200, '日本語の id のメンバーを断った');
  assert.deepStrictEqual(和の答え.中身.記録.map((r) => r.id), ['s7']);
});

test('1 ページの数：頼まれなければ 5 件。答えの大きさから次の件を返す（大きい記録は少なく・小さい記録は 25 件まで。11/20）', async () => {
  const 記録たち = (数, 射) => {
    const 出 = {};
    for (let i = 0; i < 数; i++)
      // 名前の順で s1・s2（小さい記録）より先に並ぶ id にする（最初のページが全部この大きさになるように）
      出[`/groups/${団体}/sessions/b${String(i).padStart(2, '0')}`] = {
        lastModified: 時(20000 + i),
        archers: Array.from({ length: 30 }, (_, j) => ({
          id: 'a' + j,
          name: j === 0 ? '山田 太郎' : '人' + j,
          memberId: j === 0 ? 'm1' : 'x' + j,
          marks: Array.from({ length: 射 }, () => '○'),
          arrowLocations: Array.from({ length: 射 }, () => ({ x: 0.1, y: 0.2, t: 'kasumi36' })),
        })),
      };
    return 出;
  };
  // 小さい記録：最初は 5 件、次の件は 25
  const 小 = await 呼ぶ({ 団体, 形: '全部' }, 団体の文書(記録たち(12, 1)));
  assert.strictEqual(小.中身.記録.length + 小.中身.外す.length, 初めの件);
  assert.strictEqual(小.中身.次の件, ページ);
  // 大きい記録（30 人 × 40 射の矢所つき）：次の件は少なく
  const 大 = await 呼ぶ({ 団体, 形: '全部' }, 団体の文書(記録たち(12, 40)));
  assert.strictEqual(大.中身.記録.length + 大.中身.外す.length, 初めの件);
  assert.ok(大.中身.次の件 >= 1 && 大.中身.次の件 < 初めの件, '大きい記録なのに次の件を減らさない：' + 大.中身.次の件);
  // 件は 1〜25 に収める。id は 5 件まで
  const 多すぎ = await 呼ぶ({ 団体, 形: '全部', 件: 999 }, 団体の文書(記録たち(30, 1)));
  assert.strictEqual(多すぎ.中身.記録.length + 多すぎ.中身.外す.length, ページ);
  assert.strictEqual(idの上限, 5);
  assert.strictEqual((await 呼ぶ({ 団体, 形: 'id', ids: ['a', 'b', 'c', 'd', 'e', 'f'] })).状態, 400);
});

test('所属の確かめは 60 秒控え、続けて呼ばれたら証・帳面・名簿を読み直さない（11/20）', async () => {
  確かめの控えを忘れる();
  const 一 = await 呼ぶ({ 団体, 形: '全部' }, 団体の文書(), {}, true);
  assert.strictEqual(一.状態, 200);
  const 二 = await 呼ぶ({ 団体, 形: '全部' }, 団体の文書(), {}, true);
  assert.strictEqual(二.状態, 200);
  const 読んだ = 二.雲.読んだ道;
  assert.ok(!読んだ.some((道) => 道.includes('/member_claims/')), '続けて呼んだのに所属の証を読み直した');
  // 別の団体を頼んだら控えは使わない（その団体の証で確かめて断る）
  const よそ = await 呼ぶ({ 団体: '100002', 形: '全部' }, 団体の文書(), {}, true);
  assert.strictEqual(よそ.状態, 403);
  確かめの控えを忘れる();
});

test('前の版の矢所（0・1・2…を鍵にした表）も、自分の射の分を並びで返す（11/20）', () => {
  const 出 = 自分の行だけにする(
    {
      id: 's1',
      archers: [
        {
          id: 'a1',
          name: '山田 太郎',
          memberId: 'm1',
          marks: ['○', '×'],
          arrowLocations: { 0: { x: 0.1, y: 0.2 }, 1: { x: 0.3, y: 0.4 } },
        },
      ],
    },
    'm1',
    '山田 太郎'
  );
  assert.deepStrictEqual(出.archers[0].arrowLocations, [
    { x: 0.1, y: 0.2 },
    { x: 0.3, y: 0.4 },
  ]);
});
