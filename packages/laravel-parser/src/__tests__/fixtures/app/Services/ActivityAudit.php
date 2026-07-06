<?php

namespace App\Services;

use App\Models\User;
use App\Enums\ActivityType;

class ActivityAudit
{
    public function logDeletion(User $user): void
    {
        Activity::add(ActivityType::USER_DELETE, $user);
    }

    public function logViaHelper(User $user): void
    {
        activity()->log('user.deleted');
    }

    public function notAnAuditCall(User $user): void
    {
        Mail::to($user)->send(new WelcomeMail());
    }
}
