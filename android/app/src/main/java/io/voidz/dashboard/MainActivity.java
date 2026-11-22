package io.voidz.dashboard;

import android.annotation.SuppressLint;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.appcompat.app.AppCompatActivity;

/**
 * Thin WebView shell around the Voidz.IO dashboard. It just loads the
 * site full-screen and keeps navigation (login redirects, etc.) inside
 * the app rather than kicking out to Chrome.
 */
public class MainActivity extends AppCompatActivity {

    // Where the dashboard lives. voidz.io is a public domain; everything
    // sensitive sits behind the login, so there's nothing secret here.
    private static final String DASHBOARD_URL = "https://voidz.io/";

    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);          // the dashboard is a JS app
        s.setDomStorageEnabled(true);          // localStorage (themes, layout, etc.)
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // alert sounds

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        // Stay in-app for same-origin navigation; the default client does this.
        webView.setWebViewClient(new WebViewClient());

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(DASHBOARD_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    // Hardware/gesture back navigates the web history instead of closing
    // the app, until there's nothing left to go back to.
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
