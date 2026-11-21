package ng.sentri.sentri

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock

/**
 * v46: keeps the emergency triggers alive when the app has not been opened for days.
 *
 * The always-on [ProtectionService] is START_STICKY, and the boot receiver restarts it after a
 * reboot or an app update. What neither can survive is the slow drift: a battery manager that
 * killed the service and never restarted it, a swiped-away task on a phone that does not restart
 * swiped apps, weeks of the person never opening the app. A trigger pulled on a dead protection
 * service is a trigger that does nothing - the worst failure this app can have.
 *
 * So the service keeps a standing alarm-clock entry with the SYSTEM (the same OEM-safe alarm the
 * drink-water chain uses: an alarm-clock entry is shown in the status bar as the user's own, and
 * battery managers leave those alone). Every 15 minutes the alarm wakes this receiver, which:
 *   1. restarts [ProtectionService] when the person has protection on (starting it again when it
 *      is already running is harmless - it just re-applies the trigger settings), and
 *   2. re-arms the NEXT 15-minute alarm itself, so the chain is self-perpetuating like the
 *      water chain and cannot be cut off by one lost link.
 * The receiver also pre-warms [SentriEngine], so the shared Flutter engine exists before any
 * trigger needs it - a gesture on a sleeping phone starts the alert without waiting for one.
 *
 * Everything here is a no-op when protection is off (the alarm is simply cancelled), so a person
 * who turned Sentri off gets exactly the silence they asked for.
 */
class AlertKeepalive : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_TICK) return
        val p = Prefs.load(context)
        if (!p.enabled) {
            cancel(context)
            return
        }
        // Restart protection (no-op when it is alive), pre-warm the engine, re-arm the next tick.
        ProtectionService.start(context)
        try {
            SentriEngine.get(context)
            // v50: the keep-alive tick is the only code that runs while the phone
            // has been asleep for days. Re-send any SOS saved while it was offline.
            TriggerDispatcher.begin(context, "resume")
        } catch (_: Exception) {
            // The engine failing to warm must never kill the alarm chain: the next tick tries again.
        }
        arm(context)
    }

    companion object {
        const val ACTION_TICK = "ng.sentri.sentri.KEEPALIVE"
        private const val REQUEST = 7305
        private const val INTERVAL_MS = 15 * 60_000L

        private fun showIntent(ctx: Context): PendingIntent = PendingIntent.getActivity(
            ctx, REQUEST, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        /** Lays (or renews) the standing 15-minute alarm. Safe to call often: it replaces itself. */
        fun arm(ctx: Context) {
            val am = ctx.getSystemService(AlarmManager::class.java) ?: return
            if (!Prefs.load(ctx).enabled) {
                cancel(ctx)
                return
            }
            val at = System.currentTimeMillis() + INTERVAL_MS
            val pi = PendingIntent.getBroadcast(
                ctx, REQUEST, Intent(ctx, AlertKeepalive::class.java).setAction(ACTION_TICK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            try {
                // Alarm-clock mode: the entry the system shows the person, which OEM battery
                // managers do not prune. Exact alarm and window fallbacks below.
                am.setAlarmClock(AlarmManager.AlarmClockInfo(at, showIntent(ctx)), pi)
            } catch (_: SecurityException) {
                try {
                    am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + INTERVAL_MS, pi)
                } catch (_: Exception) {
                    am.setWindow(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + INTERVAL_MS, 10 * 60_000L, pi)
                }
            }
        }

        /** When the person turns protection off, the standing alarm goes with it. */
        fun cancel(ctx: Context) {
            val am = ctx.getSystemService(AlarmManager::class.java) ?: return
            val pi = PendingIntent.getBroadcast(
                ctx, REQUEST, Intent(ctx, AlertKeepalive::class.java).setAction(ACTION_TICK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE,
            )
            if (pi != null) {
                try { am.cancel(pi) } catch (_: Exception) {}
            }
        }
    }
}
