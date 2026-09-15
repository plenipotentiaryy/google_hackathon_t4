async function show(mode) {
  const html = await (await fetch("../extension/options.html")).text();
  const stub =
    mode === "unavailable"
      ? ""
      : `<script>
    const store = ${JSON.stringify(mode === "saved" ? { apiKey: "preview-only-not-a-real-key", voice: "Kore" } : {})};
    const listeners=[];
    window.chrome={storage:{local:{get:async()=>({...store}),set:async update=>{const changes={};for(const k in update){changes[k]={newValue:update[k]};store[k]=update[k];}listeners.forEach(fn=>fn(changes,'local'));},remove:async keys=>keys.forEach(k=>delete store[k])},onChanged:{addListener:fn=>listeners.push(fn)}}};
  </scr` + `ipt>`;
  document.querySelector("iframe").srcdoc = html.replace(
    "<head>",
    '<head><base href="' +
      new URL("../extension/", location.href).href +
      '">' +
      stub,
  );
}
document.getElementById("empty").onclick = () => show("empty");
document.getElementById("saved").onclick = () => show("saved");
document.getElementById("unavailable").onclick = () => show("unavailable");
show("saved");
