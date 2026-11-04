package dev.luna.mobile

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

/** Hands the FCM registration token to the web UI. The daemon sends the pushes; Android shows them. */
@TauriPlugin
class PushPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun getToken(invoke: Invoke) {
    // Android 13+ blocks notifications until the user allows them.
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    // Builds without google-services.json have no Firebase app: push is simply unavailable.
    if (FirebaseApp.getApps(activity).isEmpty()) return invoke.reject("Firebase is not configured in this build")
    FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
      if (task.isSuccessful) invoke.resolve(JSObject().put("token", task.result))
      else invoke.reject(task.exception?.message ?: "Could not get the push token")
    }
  }
}
