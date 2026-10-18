package io.github.mactzer.megacontrol;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Shared native visual system: shapes, type, touch targets and vector icons. */
final class Ui {
  static final int BRAND = 0xff116b57,
      DARK = 0xff103f35,
      INK = 0xff18352e,
      MUTED = 0xff63786b,
      BG = 0xfff3f7f4,
      PALE = 0xffe8f3ed,
      BORDER = 0xffe1eae4;

  static int dp(Context c, float n) {
    return Math.round(n * c.getResources().getDisplayMetrics().density);
  }

  static GradientDrawable shape(Context c, int color, int radius) {
    GradientDrawable d = new GradientDrawable();
    d.setColor(color);
    d.setCornerRadius(dp(c, radius));
    return d;
  }

  static Drawable ripple(Context c, int color, int radius) {
    return new RippleDrawable(ColorStateList.valueOf(0x24116b57), shape(c, color, radius), null);
  }

  static void bold(TextView text) {
    text.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
  }

  static TextView label(Context c, String value, int size, int color) {
    TextView t = new TextView(c);
    t.setText(value);
    t.setTextSize(size);
    t.setTextColor(color);
    t.setFontFeatureSettings("kern");
    t.setIncludeFontPadding(false);
    t.setLineSpacing(dp(c, 3), 1);
    return t;
  }

  static void space(LinearLayout parent, int height) {
    parent.addView(
        new View(parent.getContext()),
        new LinearLayout.LayoutParams(1, dp(parent.getContext(), height)));
  }

  static void styleButton(Button b, boolean primary, String icon) {
    Context c = b.getContext();
    b.setStateListAnimator(null);
    b.setElevation(primary ? dp(c, 1) : 0);
    b.setAllCaps(false);
    b.setTextSize(14);
    bold(b);
    b.setLetterSpacing(.01f);
    b.setMinHeight(dp(c, 50));
    b.setMinimumHeight(dp(c, 50));
    b.setMinWidth(0);
    b.setMinimumWidth(0);
    b.setPadding(dp(c, 16), dp(c, 11), dp(c, 16), dp(c, 11));
    b.setGravity(Gravity.CENTER);
    b.setBackgroundTintList(null);
    StateListDrawable background = new StateListDrawable();
    background.addState(
        new int[] {-android.R.attr.state_enabled}, shape(c, primary ? 0xffa2bdb1 : 0xffeef2ef, 15));
    background.addState(new int[] {}, ripple(c, primary ? BRAND : PALE, 15));
    b.setBackground(background);
    b.setTextColor(
        new ColorStateList(
            new int[][] {new int[] {-android.R.attr.state_enabled}, new int[] {}},
            new int[] {primary ? 0xffeff6f1 : 0xff9aa99f, primary ? Color.WHITE : BRAND}));
    if (icon != null) {
      b.setCompoundDrawablesRelativeWithIntrinsicBounds(
          new Icon(c, icon, primary ? Color.WHITE : BRAND, 19), null, null, null);
      b.setCompoundDrawablePadding(dp(c, 9));
    }
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
    lp.setMargins(0, dp(c, 6), 0, dp(c, 4));
    b.setLayoutParams(lp);
    if (primary) b.setElevation(dp(c, 2));
  }

  static Button action(Context c, String title, String icon, boolean primary, Runnable click) {
    Button b = new Button(c);
    b.setText(title);
    styleButton(b, primary, icon);
    b.setOnClickListener(v -> click.run());
    return b;
  }

  static Button iconButton(
      Context c, String icon, String description, int color, int background, Runnable action) {
    Button b = new Button(c);
    b.setStateListAnimator(null);
    b.setElevation(0);
    b.setAllCaps(false);
    b.setText("");
    b.setPadding(dp(c, 13), dp(c, 13), dp(c, 13), dp(c, 13));
    b.setMinWidth(0);
    b.setMinimumWidth(0);
    b.setMinHeight(0);
    b.setMinimumHeight(0);
    b.setBackgroundTintList(null);
    b.setBackground(ripple(c, background, 16));
    b.setCompoundDrawables(new Icon(c, icon, color, 22), null, null, null);
    b.setGravity(Gravity.CENTER);
    b.setContentDescription(description);
    b.setOnClickListener(v -> action.run());
    b.setLayoutParams(new LinearLayout.LayoutParams(dp(c, 48), dp(c, 48)));
    return b;
  }

  static TextView badge(Context c, String value, int foreground, int background) {
    TextView t = label(c, value, 11, foreground);
    bold(t);
    t.setPadding(dp(c, 10), dp(c, 6), dp(c, 10), dp(c, 6));
    t.setBackground(shape(c, background, 20));
    t.setLayoutParams(new LinearLayout.LayoutParams(-2, -2));
    return t;
  }

  static ImageView image(Context c, String icon, int color, int size) {
    ImageView v = new ImageView(c);
    v.setImageDrawable(new Icon(c, icon, color, size));
    return v;
  }

  static LinearLayout nav(Context c, String label, String icon, Runnable action) {
    LinearLayout item = new LinearLayout(c);
    item.setOrientation(LinearLayout.VERTICAL);
    item.setGravity(Gravity.CENTER);
    item.setPadding(0, dp(c, 7), 0, dp(c, 5));
    item.setBackground(ripple(c, Color.WHITE, 18));
    LinearLayout pill = new LinearLayout(c);
    pill.setGravity(Gravity.CENTER);
    pill.addView(image(c, icon, MUTED, 23), new LinearLayout.LayoutParams(dp(c, 25), dp(c, 25)));
    item.addView(pill, new LinearLayout.LayoutParams(dp(c, 62), dp(c, 31)));
    TextView text = label(c, label, 11, MUTED);
    bold(text);
    text.setGravity(Gravity.CENTER);
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
    lp.topMargin = dp(c, 4);
    item.addView(text, lp);
    item.setContentDescription(label);
    item.setClickable(true);
    item.setFocusable(true);
    item.setOnClickListener(v -> action.run());
    return item;
  }

  static void selectNav(LinearLayout item, boolean selected, String icon) {
    Context c = item.getContext();
    LinearLayout pill = (LinearLayout) item.getChildAt(0);
    pill.setBackground(shape(c, selected ? PALE : Color.TRANSPARENT, 18));
    ((ImageView) pill.getChildAt(0))
        .setImageDrawable(new Icon(c, icon, selected ? BRAND : MUTED, 23));
    ((TextView) item.getChildAt(1)).setTextColor(selected ? BRAND : MUTED);
    item.setSelected(selected);
  }

  static final class Icon extends Drawable {
    final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
    final String name;
    final int size;

    Icon(Context c, String name, int color, int size) {
      this.name = name;
      this.size = dp(c, size);
      p.setColor(color);
      p.setStyle(Paint.Style.STROKE);
      p.setStrokeWidth(1.8f);
      p.setStrokeCap(Paint.Cap.ROUND);
      p.setStrokeJoin(Paint.Join.ROUND);
      setBounds(0, 0, this.size, this.size);
    }

    void line(Canvas c, float... v) {
      Path path = new Path();
      path.moveTo(v[0], v[1]);
      for (int i = 2; i < v.length; i += 2) path.lineTo(v[i], v[i + 1]);
      c.drawPath(path, p);
    }

    @Override
    public void draw(Canvas canvas) {
      int save = canvas.save();
      canvas.translate(getBounds().left, getBounds().top);
      canvas.scale(getBounds().width() / 24f, getBounds().height() / 24f);
      switch (name) {
        case "scan":
          line(canvas, 3, 8, 3, 4, 8, 4);
          line(canvas, 16, 4, 21, 4, 21, 8);
          line(canvas, 3, 16, 3, 20, 8, 20);
          line(canvas, 16, 20, 21, 20, 21, 16);
          for (int x : new int[] {7, 10, 13, 17}) line(canvas, x, 8, x, 16);
          break;
        case "archive":
          canvas.drawRoundRect(4, 7, 20, 21, 2, 2, p);
          line(canvas, 3, 3, 21, 3, 21, 7, 3, 7, 3, 3);
          line(canvas, 9, 11, 15, 11);
          break;
        case "history":
          canvas.drawArc(4, 4, 21, 21, -135, 295, false, p);
          line(canvas, 3, 4, 3, 10, 9, 10);
          line(canvas, 12, 8, 12, 13, 16, 15);
          break;
        case "chat":
          canvas.drawRoundRect(3, 3, 21, 18, 4, 4, p);
          line(canvas, 8, 18, 5, 22, 5, 17);
          line(canvas, 7, 8, 17, 8);
          line(canvas, 7, 12, 14, 12);
          break;
        case "search":
          canvas.drawCircle(10.5f, 10.5f, 6.5f, p);
          line(canvas, 16, 16, 21, 21);
          break;
        case "photo":
          canvas.drawRoundRect(3, 4, 21, 20, 3, 3, p);
          canvas.drawCircle(8, 9, 1, p);
          line(canvas, 4, 17, 10, 12, 14, 16, 17, 13, 21, 17);
          break;
        case "back":
          line(canvas, 14, 5, 7, 12, 14, 19);
          line(canvas, 7, 12, 21, 12);
          break;
        case "arrow":
          line(canvas, 4, 12, 20, 12);
          line(canvas, 14, 6, 20, 12, 14, 18);
          break;
        case "chevron":
          line(canvas, 9, 5, 16, 12, 9, 19);
          break;
        case "close":
          line(canvas, 6, 6, 18, 18);
          line(canvas, 18, 6, 6, 18);
          break;
        case "flash":
          line(canvas, 13, 2, 5, 14, 11, 14, 10, 22, 19, 9, 13, 9, 13, 2);
          break;
        case "shield":
          line(canvas, 12, 2, 21, 6, 20, 14, 17, 19, 12, 22, 7, 19, 4, 14, 3, 6, 12, 2);
          line(canvas, 8, 12, 11, 15, 16, 9);
          break;
        case "download":
          line(canvas, 12, 3, 12, 16);
          line(canvas, 7, 11, 12, 16, 17, 11);
          line(canvas, 4, 16, 4, 21, 20, 21, 20, 16);
          break;
        case "edit":
          line(canvas, 4, 20, 5, 14, 16, 3, 21, 8, 10, 19, 4, 20);
          line(canvas, 14, 5, 19, 10);
          break;
        case "document":
          line(canvas, 5, 2, 15, 2, 20, 7, 20, 22, 5, 22, 5, 2);
          line(canvas, 14, 2, 14, 8, 20, 8);
          line(canvas, 9, 13, 16, 13);
          line(canvas, 9, 17, 16, 17);
          break;
        case "send":
          line(canvas, 3, 3, 22, 12, 3, 21, 7, 12, 3, 3);
          line(canvas, 7, 12, 22, 12);
          break;
        case "user":
          canvas.drawCircle(12, 8, 4, p);
          canvas.drawArc(4, 14, 20, 29, 180, 180, false, p);
          break;
        case "check":
          line(canvas, 4, 12, 10, 18, 21, 6);
          break;
        case "more":
          for (int y : new int[] {5, 12, 19}) canvas.drawCircle(12, y, .8f, p);
          break;
        default:
          canvas.drawRoundRect(4, 4, 20, 20, 4, 4, p);
          break;
      }
      canvas.restoreToCount(save);
    }

    @Override
    public void setAlpha(int alpha) {
      p.setAlpha(alpha);
      invalidateSelf();
    }

    @Override
    public void setColorFilter(ColorFilter filter) {
      p.setColorFilter(filter);
      invalidateSelf();
    }

    @Override
    public int getOpacity() {
      return PixelFormat.TRANSLUCENT;
    }

    @Override
    public int getIntrinsicWidth() {
      return size;
    }

    @Override
    public int getIntrinsicHeight() {
      return size;
    }
  }
}
