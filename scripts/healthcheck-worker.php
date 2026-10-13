<?php
// Readiness only: never execute scheduled tasks or dispatch a test job.
try {
    $expected = $argv[1] ?? '';
    if (!in_array($expected, ['horizon', 'schedule:work'], true)) exit(1);
    $command = str_replace("\0", ' ', file_get_contents('/proc/1/cmdline'));
    if (!str_contains($command, 'php artisan '.$expected)) exit(1);
    chdir('/var/www/html');
    require 'vendor/autoload.php';
    $app = require 'bootstrap/app.php';
    $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
    Illuminate\Support\Facades\DB::select('SELECT 1');
    Illuminate\Support\Facades\Redis::connection()->ping();
    if ($expected === 'horizon' && Illuminate\Support\Facades\Artisan::call('horizon:status') !== 0) exit(1);
    echo "ready\n";
    exit(0);
} catch (Throwable $exception) {
    fwrite(STDERR, "worker readiness failed\n");
    exit(1);
}
