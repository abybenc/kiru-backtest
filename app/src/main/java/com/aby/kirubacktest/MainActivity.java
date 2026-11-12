package com.aby.kirubacktest;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.JsonReader;
import android.util.JsonToken;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;

public class MainActivity extends Activity {
    private WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(3);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#0e1116"));
        getWindow().setNavigationBarColor(Color.parseColor("#171b22"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0e1116"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "Native");
        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");
    }

    private void reply(String id, boolean ok, String payload) {
        final String js = "window.__nativeCb(" + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(payload == null ? "" : payload) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("User-Agent", "KiruBacktest/1.0 (Android)");
        return c;
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toString("UTF-8");
    }

    class Bridge {
        @JavascriptInterface
        public void fetch(final String id, final String url) {
            pool.execute(() -> {
                try {
                    HttpURLConnection c = open(url);
                    int code = c.getResponseCode();
                    InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                    String body = in == null ? "" : readAll(in);
                    if (code >= 400) reply(id, false, "HTTP " + code + " " + body.substring(0, Math.min(200, body.length())));
                    else reply(id, true, body);
                } catch (Exception e) {
                    reply(id, false, e.getClass().getSimpleName() + ": " + e.getMessage());
                }
            });
        }

        /** Streams Upstox's NSE instrument master and returns {SYMBOL: instrument_key} for NSE_EQ symbols asked for. */
        @JavascriptInterface
        public void findInstruments(final String id, final String symbolsCsv) {
            pool.execute(() -> {
                Set<String> want = new HashSet<>(Arrays.asList(symbolsCsv.toUpperCase().split(",")));
                JSONObject out = new JSONObject();
                try {
                    HttpURLConnection c = open("https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz");
                    try (JsonReader r = new JsonReader(new InputStreamReader(new GZIPInputStream(new BufferedInputStream(c.getInputStream(), 65536)), "UTF-8"))) {
                        r.beginArray();
                        while (r.hasNext() && out.length() < want.size()) {
                            String seg = null, key = null, sym = null;
                            r.beginObject();
                            while (r.hasNext()) {
                                String name = r.nextName();
                                if (r.peek() == JsonToken.STRING && (name.equals("segment") || name.equals("instrument_key") || name.equals("trading_symbol"))) {
                                    String v = r.nextString();
                                    if (name.equals("segment")) seg = v; else if (name.equals("instrument_key")) key = v; else sym = v;
                                } else r.skipValue();
                            }
                            r.endObject();
                            if ("NSE_EQ".equals(seg) && sym != null && key != null && want.contains(sym.toUpperCase()) && !out.has(sym.toUpperCase()))
                                out.put(sym.toUpperCase(), key);
                        }
                    }
                    reply(id, true, out.toString());
                } catch (Exception e) {
                    if (out.length() > 0) reply(id, true, out.toString());
                    else reply(id, false, "Instrument lookup failed: " + e.getMessage());
                }
            });
        }

        @JavascriptInterface
        public void openBroker(final String which) {
            runOnUiThread(() -> {
                String pkg = "kite".equals(which) ? "com.zerodha.kite3" : "in.upstox.app";
                String webUrl = "kite".equals(which) ? "https://kite.zerodha.com" : "https://pro.upstox.com";
                Intent i = getPackageManager().getLaunchIntentForPackage(pkg);
                if (i == null) i = new Intent(Intent.ACTION_VIEW, Uri.parse(webUrl));
                try { startActivity(i); } catch (Exception ignored) { }
            });
        }
    }

    @Override
    public void onBackPressed() {
        moveTaskToBack(true);
    }
}
