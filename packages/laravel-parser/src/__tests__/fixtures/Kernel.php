<?php

namespace App\Console;

use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Console\Kernel as ConsoleKernel;
use App\Jobs\SendHeartbeat;

class Kernel extends ConsoleKernel
{
    protected function schedule(Schedule $schedule): void
    {
        $schedule->command('report:generate')->daily();

        $schedule->command('emails:send', ['--force'])->everyFiveMinutes();

        $schedule->command('backup:run')->cron('0 3 * * *');

        $schedule->job(new SendHeartbeat())->hourly();
    }
}
