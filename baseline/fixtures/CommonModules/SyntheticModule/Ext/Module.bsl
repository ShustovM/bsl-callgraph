// Stable synthetic fixture for baseline comparisons.

Procedure PublicProcedure(First, Second = 0) Export

    HelperProcedure(First);
    OtherModule.ExportedMethod(Second);
    Result = CalculateValue(First, Second);

EndProcedure

Function CalculateValue(Value1, Value2) Export

    Result = SharedModule.SharedFunction(Value1);
    Result = Result + HelperCalculation(Value2);
    Return Result;

EndFunction

Procedure HelperProcedure(Value)

    Object = New Array;
    Object.Add(Value);
    SharedModule.WriteLog("Synthetic baseline");

EndProcedure

Function HelperCalculation(Value)

    Return Value * 2;

EndFunction
