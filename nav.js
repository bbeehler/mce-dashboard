/* MarComms suite navigation — shared by every MarComms page.
   To add a page: add one line to PAGES below and include this script on the new page:
     <script src="https://bbeehler.github.io/mce-dashboard/nav.js" data-current="your-id"></script>
   Put the tag straight after <body> so the bar appears before the rest of the page. */
(function () {
  var PAGES = [
    { id: "dashboard", label: "Executive Dashboard", href: "https://bbeehler.github.io/mce-dashboard/" },
    { id: "membership", label: "Membership",         href: "https://bbeehler.github.io/mce-dashboard/membership.html" },
    { id: "eblast",    label: "eBlast Calendar",     href: "https://bbeehler.github.io/eblast-calendar/" },
    // { id: "new-page", label: "New page", href: "https://bbeehler.github.io/new-page/" },
    { id: "upload",    label: "Upload data",         href: "https://bbeehler.github.io/mce-dashboard/upload.html", side: "end" }
  ];

  var me = document.currentScript;
  var current = (me && me.getAttribute("data-current")) || "";
  if (document.getElementById("suite-nav")) return;

  var css =
    "#suite-nav{background:#0b1230;color:#c9d2ea;font:500 13px/1 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;position:relative;z-index:50}" +
    "#suite-nav .sn-in{max-width:1240px;margin:0 auto;padding:0 20px;display:flex;align-items:stretch;gap:4px;height:40px;overflow-x:auto;scrollbar-width:none}" +
    "#suite-nav .sn-in::-webkit-scrollbar{display:none}" +
    "#suite-nav .sn-brand{display:flex;align-items:center;gap:8px;color:#fff;font-weight:700;letter-spacing:.02em;margin-right:14px;white-space:nowrap;text-decoration:none}" +
    "#suite-nav .sn-brand i{width:8px;height:8px;border-radius:2px;background:#e31b4b;display:inline-block}" +
    "#suite-nav .sn-brand span{color:#8f9bc0;font-weight:500}" +
    "#suite-nav a.sn-l{display:flex;align-items:center;padding:0 12px;color:#c9d2ea;text-decoration:none;white-space:nowrap;border-bottom:3px solid transparent;border-top:3px solid transparent}" +
    "#suite-nav a.sn-l:hover{color:#fff;background:rgba(255,255,255,.06)}" +
    "#suite-nav a.sn-l:focus-visible{outline:2px solid #9fb4e6;outline-offset:-4px}" +
    "#suite-nav a.sn-l[aria-current=page]{color:#fff;font-weight:650;border-bottom-color:#e31b4b}" +
    "#suite-nav .sn-gap{flex:1;min-width:12px}" +
    "@media (max-width:640px){#suite-nav .sn-in{padding:0 12px}#suite-nav .sn-brand span{display:none}#suite-nav a.sn-l{padding:0 9px}}" +
    "@media print{#suite-nav{display:none!important}}";

  var st = document.createElement("style");
  st.id = "suite-nav-css";
  st.textContent = css;
  document.head.appendChild(st);

  function link(p) {
    var a = document.createElement("a");
    a.className = "sn-l";
    a.href = p.href;
    a.textContent = p.label;
    if (p.id === current) a.setAttribute("aria-current", "page");
    return a;
  }

  var nav = document.createElement("nav");
  nav.id = "suite-nav";
  nav.setAttribute("aria-label", "MarComms tools");
  var inner = document.createElement("div");
  inner.className = "sn-in";

  var brand = document.createElement("a");
  brand.className = "sn-brand";
  brand.href = PAGES[0].href;
  brand.innerHTML = "<i></i>AIA Canada<span>&nbsp;· MarComms</span>";
  inner.appendChild(brand);

  PAGES.filter(function (p) { return p.side !== "end"; }).forEach(function (p) { inner.appendChild(link(p)); });
  var gap = document.createElement("span");
  gap.className = "sn-gap";
  inner.appendChild(gap);
  PAGES.filter(function (p) { return p.side === "end"; }).forEach(function (p) { inner.appendChild(link(p)); });

  nav.appendChild(inner);
  function mount() {
    document.body.insertBefore(nav, document.body.firstChild);
    // On narrow screens the bar scrolls sideways; make sure the current page is in view.
    var on = inner.querySelector("[aria-current]");
    if (on && on.offsetLeft + on.offsetWidth > inner.clientWidth) inner.scrollLeft = on.offsetLeft + on.offsetWidth - inner.clientWidth + 12;
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
