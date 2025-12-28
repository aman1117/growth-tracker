package com.growthtracker.app.domain.model

data class Activity(
    val id: Int,
    val name: String,
    val hours: Float
) {
    val activityType: ActivityType?
        get() = ActivityType.fromApiName(name)
}
