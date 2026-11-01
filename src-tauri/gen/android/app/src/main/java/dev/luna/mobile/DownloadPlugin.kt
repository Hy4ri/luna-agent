package dev.luna.mobile

import android.app.Activity
import android.content.ContentValues
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import android.widget.Toast
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.IOException

@InvokeArg
class SaveArgs {
  lateinit var name: String
  var mime: String? = null
  lateinit var data: String
}

/** Saves a file into the shared Downloads collection. Android WebView ignores `<a download>` on blob URLs. */
@TauriPlugin
class DownloadPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun save(invoke: Invoke) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw IOException("Saving files needs Android 10 or later")
      val args = invoke.parseArgs(SaveArgs::class.java)
      val name = args.name.replace(Regex("[/\\\\\\u0000]"), "_").ifBlank { "download" }
      val bytes = Base64.decode(args.data, Base64.DEFAULT)
      val resolver = activity.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, name)
        put(MediaStore.Downloads.MIME_TYPE, args.mime?.takeIf { it.isNotBlank() } ?: "application/octet-stream")
        put(MediaStore.Downloads.IS_PENDING, 1)
      }
      val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw IOException("Android refused to create the file")
      try {
        (resolver.openOutputStream(uri) ?: throw IOException("Cannot open the file for writing")).use { it.write(bytes) }
        resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
      } catch (e: Exception) {
        resolver.delete(uri, null, null)
        throw e
      }
      // Android renames a duplicate ("a (1).pdf"), so report the name it really used.
      val saved = resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use {
        if (it.moveToFirst()) it.getString(0) else null
      } ?: name
      activity.runOnUiThread { Toast.makeText(activity, "Saved to Downloads: $saved", Toast.LENGTH_SHORT).show() }
      invoke.resolve(JSObject().put("name", saved))
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Could not save the file")
    }
  }
}
