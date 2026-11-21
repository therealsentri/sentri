package ng.sentri.sentri

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restarts protection after a reboot or an app update, if the user had it on.
 *
 * v45: also tops the drink-water chain up here. The chain re-seeds itself through
 * WaterBootReceiver, but some power managers delay or drop one of the two boot
 * broadcasts - this is a second chance. rearmIfStale only acts when the chain
 * actually starved (firing time passed, or the alarm-clock entry was pruned), so
 * it can never double-schedule or push a healthy pace out.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            if (Prefs.load(context).enabled) ProtectionService.start(context)
            WaterReminderReceiver.rearmIfStale(context)
            // v46: arm the trigger keep-alive on boot too - one more place the standing
            // alarm that keeps the emergency gestures alive renews itself.
            AlertKeepalive.arm(context)
        }
    }
}
