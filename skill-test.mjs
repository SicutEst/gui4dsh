const H = 'Authorization: Bearer 0CW9Z5agaYheOgKCU19_MDX9aFnlwDyb';
const call = async (method, payload) => {
  const res = await fetch(`http://127.0.0.1:7420/api/dsh/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Authorization': H },
    body: JSON.stringify(payload),
  });
  return res.json();
};

for (const cwd of ['D:\\dsh\\cv analyzer', 'D:\\Zcode Project\\gui4dsh', 'C:\\Users\\yl']) {
  const r = await call('session.create', { cwd });
  if (!r.ok) { console.log(cwd, 'create FAIL', r.error?.message); continue; }
  const sid = r.value.sessionId;
  await new Promise((rs) => setTimeout(rs, 1500));
  const lr = await call('skill.list', { sessionId: sid });
  console.log(
    cwd, '→',
    lr.ok
      ? `${lr.value.skills.length} skills: ${lr.value.skills.map((s) => s.name).slice(0, 8).join(', ')}`
      : `FAIL ${lr.error?.message}`,
  );
}
