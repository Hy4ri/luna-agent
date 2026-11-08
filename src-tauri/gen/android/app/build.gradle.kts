import com.google.gms.googleservices.GoogleServicesTask
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "dev.luna.mobile"
    defaultConfig {
        // The daemon is reached over plain HTTP on LAN/Tailscale, so release builds need cleartext too.
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        applicationId = "dev.luna.mobile"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    implementation("com.google.firebase:firebase-messaging:24.1.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")

// Deployment config stays outside the checkout, including when building from a worktree.
val googleServicesPath = providers.gradleProperty("luna.googleServicesFile")
    .orElse(providers.environmentVariable("LUNA_GOOGLE_SERVICES"))
val googleServicesFile = if (googleServicesPath.isPresent) {
    val path = googleServicesPath.get()
    require(path.isNotBlank()) { "luna.googleServicesFile / LUNA_GOOGLE_SERVICES must not be empty" }
    rootProject.file(path)
} else {
    File(System.getProperty("user.home"), ".luna/android/google-services.json")
}
if (googleServicesPath.isPresent || googleServicesFile.exists()) {
    require(googleServicesFile.isFile && googleServicesFile.canRead()) {
        "Firebase configuration is missing or unreadable: $googleServicesFile"
    }
    apply(plugin = "com.google.gms.google-services")
    // The plugin registers variants during evaluation and sets its own input list then.
    afterEvaluate {
        tasks.withType<GoogleServicesTask>().configureEach {
            googleServicesJsonFiles.set(listOf(googleServicesFile))
        }
    }
}