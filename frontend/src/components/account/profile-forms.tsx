"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiSend } from "@/lib/api";
import { preferencesSchema, profileSchema, type PreferencesInput, type ProfileInput } from "@/lib/validation/profile";
import { FormField } from "@/components/auth/form-field";

const COMMON_ZONES = ["UTC", "Asia/Dhaka", "Asia/Kolkata", "Asia/Karachi", "Asia/Dubai", "Asia/Singapore", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney"];

export function ProfileForm({ initial, email }: { initial: ProfileInput; email: string }) {
  const router = useRouter();
  const zones = COMMON_ZONES.includes(initial.timezone) ? COMMON_ZONES : [initial.timezone, ...COMMON_ZONES];
  const { register, handleSubmit, control, setError, formState: { errors, isSubmitting, isDirty }, reset } = useForm<ProfileInput>({
    resolver: zodResolver(profileSchema),
    defaultValues: initial,
  });

  async function onSubmit(values: ProfileInput) {
    try {
      await apiSend("PATCH", "/api/profile", values);
    } catch (err) {
      if (err instanceof ApiError) {
        for (const [k, m] of Object.entries(err.fields)) setError(k as keyof ProfileInput, { message: m });
        toast.error(err.fields && Object.keys(err.fields).length ? "Please fix the highlighted fields." : err.message);
      } else throw err;
      return;
    }
    toast.success("Profile saved");
    reset(values);
    router.refresh();
  }

  return (
    <Card className="rounded-2xl shadow-card">
      <form onSubmit={handleSubmit(onSubmit)} noValidate aria-label="Profile">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Your email ({email}) can&apos;t be changed in this version.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField label="Full name" autoComplete="name" error={errors.name?.message} {...register("name")} />
          <FormField label="Display name" hint="Shown to group members in later parts." error={errors.displayName?.message} {...register("displayName")} />
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="bio">Bio</Label>
            <Textarea id="bio" rows={3} className="rounded-xl" aria-invalid={errors.bio ? true : undefined} aria-describedby={errors.bio ? "bio-error" : undefined} {...register("bio")} />
            {errors.bio && <p id="bio-error" role="alert" className="text-xs font-medium text-destructive">{errors.bio.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="timezone">Time zone</Label>
            <Controller
              control={control}
              name="timezone"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="timezone" className="h-10 w-full rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>{zones.map((z) => <SelectItem key={z} value={z}>{z}</SelectItem>)}</SelectContent>
                </Select>
              )}
            />
            {errors.timezone && <p role="alert" className="text-xs font-medium text-destructive">{errors.timezone.message}</p>}
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" className="rounded-xl" disabled={isSubmitting || !isDirty}>
            {isSubmitting && <Loader2 className="animate-spin" aria-hidden />} Save profile
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export function PreferencesForm({ initial }: { initial: PreferencesInput }) {
  const router = useRouter();
  const { setTheme } = useTheme();
  const [saving, setSaving] = useState(false);
  const { control, handleSubmit, formState: { isDirty }, reset } = useForm<PreferencesInput>({ resolver: zodResolver(preferencesSchema), defaultValues: initial });

  async function onSubmit(values: PreferencesInput) {
    setSaving(true);
    try {
      await apiSend("PATCH", "/api/preferences", values);
    } catch (err) {
      setSaving(false);
      toast.error(err instanceof ApiError ? err.message : "Something went wrong.");
      return;
    }
    setSaving(false);
    setTheme(values.theme.toLowerCase());
    toast.success("Preferences saved");
    reset(values);
    router.refresh();
  }

  return (
    <Card className="rounded-2xl shadow-card">
      <form onSubmit={handleSubmit(onSubmit)} aria-label="Preferences">
        <CardHeader>
          <CardTitle>Preferences</CardTitle>
          <CardDescription>Language selection is stored now; translated interface text arrives with the localisation work.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="theme">Theme</Label>
            <Controller control={control} name="theme" render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="theme" className="h-10 w-full rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="SYSTEM">System</SelectItem><SelectItem value="LIGHT">Light</SelectItem><SelectItem value="DARK">Dark</SelectItem>
                </SelectContent>
              </Select>
            )} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="locale">Language</Label>
            <Controller control={control} name="locale" render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="locale" className="h-10 w-full rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="en">English</SelectItem><SelectItem value="bn">বাংলা (Bangla)</SelectItem></SelectContent>
              </Select>
            )} />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-xl border p-3 sm:col-span-2">
            <div>
              <Label htmlFor="emailNotifications">Email notifications</Label>
              <p className="text-xs text-muted-foreground">Receive important account updates by email.</p>
            </div>
            <Controller control={control} name="emailNotifications" render={({ field }) => (
              <Switch id="emailNotifications" checked={field.value} onCheckedChange={field.onChange} />
            )} />
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" className="rounded-xl" disabled={saving || !isDirty}>
            {saving && <Loader2 className="animate-spin" aria-hidden />} Save preferences
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
