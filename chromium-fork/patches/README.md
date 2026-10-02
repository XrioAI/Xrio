# patches

Applied to Chromium in `series` order by `scripts/apply.sh`, against the tag in `../VERSIONS`.

| Patch | What it does |
| --- | --- |
| `xrio-sources.patch` | Adds the fork's own sources: knob registry, config and config-file loader, GL/speech/media/battery personas, perturbation and geometry helpers, and their unit tests. |
| `base-BUILD.gn.patch` | Compiles the `xrio_*` sources into `base` and their tests into `base_unittests`. |
| `chrome-app-chrome_main_delegate.cc.patch` | Loads `xrio-config.json` / `--xrio-config-file` at startup, validates every `--xrio-*` switch (refuses to launch on a bad one), adds `--xrio-dump-config`. |
| `content-common-renderer.mojom.patch` | Adds the `SetXrioConfig` message to the renderer interface. |
| `content-browser-renderer_host-render_process_host_impl.cc.patch` | Collects the config and persona tables in the browser and sends them to each renderer. |
| `content-renderer-render_thread_impl.h.patch` | Declares the renderer's `SetXrioConfig` handler. |
| `content-renderer-render_thread_impl.cc.patch` | Stores the received config in the renderer. |
| `components-embedder_support-user_agent_utils.cc.patch` | UA brand and full-version overrides; drops the `HeadlessChrome` token. |
| `components-embedder_support-user_agent_utils_unittest.cc.patch` | Tests for the headless UA token. |
| `third_party-blink-renderer-core-frame-navigator.cc.patch` | `navigator.webdriver` reports `false`. |
| `third_party-blink-renderer-core-exported-web_view_impl.cc.patch` | Exposes `hrefTranslate` as branded Chrome does. |
| `content-browser-speech-speech_synthesis_impl.cc.patch` | Serves the speech persona's voice list and routes its voices to the persona engine. |
| `content-browser-speech-tts_controller_impl.cc.patch` | Handles utterances sent to the persona speech engines. |
| `third_party-blink-renderer-modules-webgl-webgl_rendering_context_base.cc.patch` | GL persona: vendor/renderer strings, hidden extensions, capability values. |
| `third_party-blink-renderer-modules-canvas-canvas2d-base_rendering_context_2d.cc.patch` | Seeded `getImageData` perturbation (off by default). |
| `third_party-blink-renderer-platform-graphics-image_data_buffer.h.patch` | Holds the perturbed pixels for the encode path. |
| `third_party-blink-renderer-platform-graphics-image_data_buffer.cc.patch` | Applies the same perturbation to `toDataURL` / `toBlob`. |
| `third_party-blink-renderer-modules-media_capabilities-media_capabilities.h.patch` | Carries the codec family through a pending `decodingInfo()` call. |
| `third_party-blink-renderer-modules-media_capabilities-media_capabilities.cc.patch` | Decode-capability persona for `mediaCapabilities.decodingInfo()`. |
| `third_party-blink-renderer-core-frame-navigator_concurrent_hardware.cc.patch` | Overrides `navigator.hardwareConcurrency`. |
| `third_party-blink-renderer-core-frame-navigator_device_memory.cc.patch` | Overrides `navigator.deviceMemory`. |
| `content-browser-client_hints-client_hints.cc.patch` | `Device-Memory` client hint follows the override (browser side). |
| `third_party-blink-renderer-core-loader-frame_fetch_context.cc.patch` | `Device-Memory` request headers follow the override (renderer side). |
| `third_party-blink-renderer-core-timing-memory_info.cc.patch` | Overrides `performance.memory.jsHeapSizeLimit`. |
| `third_party-blink-renderer-modules-webaudio-audio_buffer.cc.patch` | Seeded `AudioBuffer` perturbation (off by default). |
| `third_party-blink-renderer-modules-webaudio-offline_audio_context.cc.patch` | Seeded `OfflineAudioContext` perturbation (off by default). |
| `third_party-blink-renderer-core-dom-element.cc.patch` | Seeded jitter for `getClientRects` / `getBoundingClientRect`. |
| `third_party-blink-renderer-core-html-canvas-text_metrics.cc.patch` | Seeded jitter for `measureText` widths. |
| `services-device-battery-BUILD.gn.patch` | Compiles the battery persona. |
| `services-device-battery-battery_status_service.cc.patch` | Battery persona for `navigator.getBattery()` (absent by default). |
| `services-device-BUILD.gn.patch` | Adds the battery persona unit test. |
| `components-variations-service-variations_service.cc.patch` | Blocks the variations (field trial) fetch. |
| `components-network_time-network_time_tracker.cc.patch` | Blocks network time queries. |
| `chrome-browser-intranet_redirect_detector.cc.patch` | Blocks the intranet redirect probe. |
| `chrome-browser-upgrade_detector-upgrade_detector_impl.cc.patch` | Disables the outdated-build detector. |
| `chrome-browser-first_run-first_run.cc.patch` | Skips first-run import. |
| `third_party-blink-renderer-core-script-detect_javascript_frameworks.cc.patch` | Disables page framework detection. |
| `components-gcm_driver-gcm_driver_desktop.cc.patch` | Blocks GCM (push) connections. |
| `components-update_client-update_checker.cc.patch` | Blocks component update pings. |
| `chrome-browser-spellchecker-spellcheck_hunspell_dictionary.cc.patch` | Blocks spellcheck dictionary downloads. |
| `components-signin-core-browser-account_reconcilor.cc.patch` | Disables Google account reconciliation. |
| `components-javascript_dialogs-app_modal_dialog_manager.cc.patch` | Auto-answers `beforeunload` dialogs. |
| `content-renderer-render_frame_impl.cc.patch` | `window.open` popups open as foreground tabs. |
| `chrome-browser-ui-startup-infobar_utils.cc.patch` | Hides startup infobars. |
| `chrome-browser-ui-browser_ui_prefs.cc.patch` | Sets the default WebRTC IP-handling policy. |
| `components-permissions-permission_request_manager.cc.patch` | Optional headful permission-prompt behaviour in headless (off by default). |
| `ui-base-x-x11_display_util.cc.patch` | Seeded taskbar-sized work area on X11. |
| `ui-ozone-platform-headless-headless_screen.cc.patch` | Same work-area panel for headless screens. |
| `ui-native_theme-native_theme.cc.patch` | Overrides `prefers-color-scheme`. |
| `build-config-compiler-BUILD.gn.patch` | Adds the `thin_lto_jobs` gn arg (default `all`) so a build can cap the ThinLTO link threads; `build.sh` sets it from `JOBS`. |
