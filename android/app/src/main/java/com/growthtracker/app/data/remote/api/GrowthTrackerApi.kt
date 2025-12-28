package com.growthtracker.app.data.remote.api

import com.growthtracker.app.data.remote.dto.*
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

interface GrowthTrackerApi {

    @GET("/")
    suspend fun healthCheck(): String

    @POST("/login")
    suspend fun login(@Body request: LoginRequest): AuthResponse

    @POST("/register")
    suspend fun register(@Body request: RegisterRequest): AuthResponse

    @POST("/users")
    suspend fun searchUsers(@Body request: SearchUsersRequest): UsersResponse

    @POST("/create-activity")
    suspend fun createActivity(@Body request: CreateActivityRequest): GenericResponse

    @POST("/get-activities")
    suspend fun getActivities(@Body request: GetActivitiesRequest): ActivitiesResponse

    @POST("/get-streak")
    suspend fun getStreak(@Body request: GetStreakRequest): StreakResponse
}
